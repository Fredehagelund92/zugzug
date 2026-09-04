/* server.ts — the thin HTTP API over the repo (ARCHITECTURE.md's backend seam).
   Bun.serve; one shared DuckDB connection underneath (serialised). The frontend
   (app/) talks to this; Vite proxies /api → :PORT in dev. */

import { env } from "./env.ts";
import { initSentry, captureError, flushSentry } from "./observability.ts";
import type { NumberFormat, GridLayoutConfig, OptionDef, PaletteName } from "./repo-shared.ts";
import type { ImportRow } from "./repo-record.ts";
import { rebalanceRefTablePositions } from "./repo-record.ts";
import { publishSummaryFor, type DraftSelector } from "./repo-drafts.ts";
import { refTableMeta } from "./repo-shared.ts";
import {
  getSessionUser,
  handleMe,
  handleLogout,
  handleAuthConfig,
  handleDevLogin,
  canMutate,
  requireAdmin,
  capabilitiesFor,
  updateUserName,
  listUsers,
  setSuperAdmin,
  type SessionUser,
  type Operation,
} from "./auth.ts";
import * as tables from "./tables.ts";
import { pgAll, pgEnd, pgGet, pgTxScoped } from "./pg.ts";
import { AppError } from "./errors.ts";
import { log } from "./log.ts";
import { createScheduler } from "./scheduler.ts";
import { buildJobs } from "./scheduler-jobs.ts";
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
  listTenantsForAdmin,
  tenantBySlug,
  memberRole,
  teardownTenant,
  listMembershipsForUser,
  listMembersForTenant,
  listInvitesForTenant,
  addMemberOrInvite,
  revokeInvite,
  setMemberRole,
  countAdmins,
  removeMember,
  updateTenantLabel,
  updateTenantColor, // ← add
  updateTenantSlug,
  leaveTenant,
} from "./tenant.ts";
import { lookupAliasedSlug } from "./slug-alias.ts";
import { appendAuditAs } from "./repo-meta.ts";
import { pgRun } from "./pg.ts";
import { pg } from "./env.ts";
import type { ServerWebSocket } from "bun";

export { checkHealth, _resetHealthCache, type HealthSnapshot } from "./health.ts";
import { checkHealth } from "./health.ts"; // used by the /api/health/connections route below
import { generateSuggestion, AINotEnabledError, isAIConfigured } from "./suggestion.ts";
import { checkRateLimit } from "./rate-limit.ts";
import {
  InvalidAPIKeyError,
  AIProviderError,
  AIResponseParseError,
  RateLimitError,
} from "./ai-providers/index.ts";

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

/** Parse a draft selection from a request body. Accepts bare source values
 *  ("publish this value, whichever draft is newest" — what the publish footer
 *  sends) and {raw, userId} objects ("exactly this person's draft" — what the
 *  Approve inbox sends, where a row per author is on screen). Returns null when
 *  the field is absent or not an array. */
function draftSelectors(v: unknown): DraftSelector[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((k) =>
    typeof k === "string"
      ? k
      : {
          raw: String((k as { raw?: unknown }).raw ?? ""),
          userId: ((k as { userId?: unknown }).userId as string | undefined) ?? null,
        },
  );
}

/** Returns a 403 Response if the role cannot perform op; null otherwise.
 * Super-admin short-circuits to allowed per the 2026-06-13 settings spec —
 * data-grid mutations follow the same elevation rule as workspace settings. */
function gateOrJson(
  ctx: { role: "admin" | "editor" | "viewer"; isSuperAdmin: boolean },
  op: Operation,
): Response | null {
  if (ctx.isSuperAdmin) return null;
  if (!canMutate(ctx.role, op)) {
    return json({ error: "forbidden", reason: `role '${ctx.role}' cannot ${op}` }, 403);
  }
  return null;
}

export async function handle(req: Request, setUid: (uid: string) => void): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const seg = pathname.split("/").filter(Boolean); // ["api","tables",":id",...]
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

  // PR2: /api/t/:slug/v1/... dispatch
  const { handleV1Route } = await import("./v1-routes.ts");
  const v1Response = await handleV1Route(req);
  if (v1Response) return v1Response;

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

  if (seg[0] !== "api") return new Response("Zug Zug API. Try /api/tables", { status: 404 });

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

    // Dev bypass — local testing only. GET only reports whether the operator
    // enabled it (no session, no cookie — the Login page probes it on render);
    // POST is the side-effecting login.
    if (seg[2] === "dev" && (method === "GET" || method === "POST")) {
      if (!env.devBypassAuth) return json({ error: "not found" }, 404);
      if (method === "GET") return json({ enabled: true });
      return handleDevLogin();
    }

    return json({ error: "not found" }, 404);
  }

  // Session gate — all other /api/* routes require a valid session
  let sessionUser;
  let saCtx: import("./auth-api-tokens.ts").ServiceAccountCtx | null = null;
  try {
    sessionUser = await getSessionUser(req);
    if (!sessionUser) {
      const { authenticateBearer } = await import("./auth-api-tokens.ts");
      const authed = await authenticateBearer(req);
      if (authed) {
        sessionUser = authed.user;
        saCtx = authed.serviceAccount ?? null;
      }
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
    // `capabilities` is the role→capability matrix from auth.ts, resolved for
    // this caller. The client gates its controls on it (app/src/lib/permissions.ts)
    // so an enabled control is one the server will accept.
    let workspaces: {
      slug: string;
      label: string;
      role: "admin" | "editor" | "viewer";
      color: string | null;
      capabilities: Operation[];
    }[];
    if (sessionUser.isSuperAdmin) {
      const allTenants = await listTenants();
      const memberMap = new Map(memberships.map((m) => [m.tenant.id, m.role]));
      workspaces = allTenants.map((t) => ({
        slug: t.slug,
        label: t.label,
        role: memberMap.get(t.id) ?? "admin",
        color: t.color ?? null,
        capabilities: capabilitiesFor(memberMap.get(t.id) ?? "admin", true),
      }));
    } else {
      workspaces = memberships.map((m) => ({
        slug: m.tenant.slug,
        label: m.tenant.label,
        role: m.role,
        color: m.tenant.color ?? null,
        capabilities: capabilitiesFor(m.role),
      }));
    }
    return json({ isSuperAdmin: sessionUser.isSuperAdmin, memberships: workspaces });
  }

  // GET /api/me/slug-alias/:slug — resolve a workspace address that was renamed
  // within the grace window to its current one, so an old bookmark or shared
  // link lands in the right workspace instead of bouncing to another. A live
  // workspace on that address wins, and we only answer for workspaces the
  // caller can actually enter.
  if (seg[1] === "me" && seg[2] === "slug-alias" && seg.length === 4 && method === "GET") {
    const oldSlug = decodeURIComponent(seg[3]!);
    const alias = await lookupAliasedSlug(oldSlug);
    if (!alias || (await tenantBySlug(oldSlug))) return json({ error: "not_found" }, 404);
    if (!sessionUser.isSuperAdmin && (await memberRole(alias.tenantId, sessionUser.id)) === null) {
      return json({ error: "not_found" }, 404);
    }
    return json({ slug: alias.currentSlug });
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
        if (method === "GET") return json({ tenants: await listTenantsForAdmin() });
        if (method === "POST") {
          // The client sends what the form asks for: `slug` (the address) and
          // `label`. It doubles as the workspace id — reading a different field
          // name here made every Create click a 500 (missing id → TypeError).
          const body = (await req.json().catch(() => ({}))) as {
            slug?: unknown;
            label?: unknown;
            color?: unknown;
          };
          const slug = typeof body.slug === "string" ? body.slug.trim() : "";
          const label = typeof body.label === "string" ? body.label.trim() : "";
          if (!slug || !label) {
            throw new AppError(
              "VALIDATION_FAILED",
              "a workspace needs both an address and a name",
              400,
            );
          }
          const tenant = await provisionTenant({
            id: slug,
            label,
            slug,
            color: typeof body.color === "string" ? body.color : undefined,
          });
          return json(tenant, 201);
        }
      }

      // PATCH /api/admin/tenants/:id — super-admin label/color edit
      if (seg[2] === "tenants" && seg.length === 4 && method === "PATCH") {
        const targetId = decodeURIComponent(seg[3]!);
        const body = (await req.json()) as { label?: string; color?: string };
        try {
          if (typeof body.label === "string") {
            await updateTenantLabel(targetId, body.label);
            // System-scope audit: tenantId "default" so it survives a later teardown
            // of the renamed tenant. actor_super_admin is unconditionally true since
            // this branch already passed the isSuperAdmin gate at line 232.
            await appendAuditAs(
              me,
              "admin.tenant.label_update",
              `renamed workspace ${targetId} to "${body.label.trim()}"`,
              {
                tenantId: "default",
                metadata: {
                  actor_super_admin: true,
                  target_tenant_id: targetId,
                  new_label: body.label.trim(),
                },
              },
            );
          }
          if (typeof body.color === "string") {
            await updateTenantColor(targetId, body.color);
          }
        } catch (e) {
          if (e instanceof AppError) {
            return json({ error: e.code, message: e.message }, e.status);
          }
          throw e;
        }
        return json({ ok: true });
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

      // GET /api/admin/audit/actions[?tenant_id=…] — distinct event types.
      if (seg[2] === "audit" && seg.length === 4 && seg[3] === "actions" && method === "GET") {
        const scope = url.searchParams.get("tenant_id") ?? "*";
        const adminRepo = new TenantRepo(scope, "admin", true);
        return json(await adminRepo.listAuditActions());
      }

      // GET /api/admin/audit[?tenant_id=…&limit=…&type=…&q=…&elevated=1&before=…]
      if (seg[2] === "audit" && seg.length === 3 && method === "GET") {
        const sp = url.searchParams;
        const limit = Math.min(200, Math.max(1, Number(sp.get("limit") ?? 30)));
        const scope = sp.get("tenant_id") ?? "*";
        const adminRepo = new TenantRepo(scope, "admin", true);
        return json(
          await adminRepo.listAudit(limit, {
            action: sp.get("type") ?? undefined,
            q: sp.get("q") ?? undefined,
            before: sp.get("before") ?? undefined,
            elevatedOnly: sp.get("elevated") === "1",
          }),
        );
      }

      // GET /api/admin/warehouse — deployment-global warehouse summary.
      if (seg[2] === "warehouse" && seg.length === 3 && method === "GET") {
        if (!sessionUser.isSuperAdmin) return json({ error: "forbidden" }, 403);
        const { listWarehouseDatabases } = await import("./repo-warehouse.ts");
        const databases = await listWarehouseDatabases();
        return json({
          adapter: env.warehouseAdapter,
          configuredFrom: "env",
          envVarName: env.warehouseAdapter === "motherduck" ? "MOTHERDUCK_TOKEN" : null,
          bootValidation: { ok: true },
          databases,
        });
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
            `INSERT INTO ${pg("active_sessions")} (user_id, last_seen, tenant_id, impersonating_tenant_id)
             VALUES ($1, current_timestamp, $2, $2)
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
      captureError(e, { method, path: pathname });
      return err(e);
    }
  }

  // /api/warehouse/... — deployment-global warehouse resources (databases + health).
  // Lives outside the tenant scope: the warehouse adapter is configured from env,
  // and registered databases are shared across all tenants in this deployment.
  if (tenantSlugFromPath === null && seg[1] === "warehouse") {
    // GET /api/warehouse/health — adapter ping
    if (seg[2] === "health" && seg.length === 3 && method === "GET") {
      if (!env.attachWarehouse) {
        return json({ ok: true, reason: "warehouse_disabled" });
      }
      const { getAdapter: getAdapterFn } = await import("./warehouse/registry.ts");
      try {
        const adapter = await getAdapterFn();
        await adapter.ping();
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    // GET /api/warehouse/info — connection-level metadata (adapter type). Any authenticated user.
    if (seg[2] === "info" && seg.length === 3 && method === "GET") {
      const { getAdapter: getAdapterFn } = await import("./warehouse/registry.ts");
      try {
        const adapter = await getAdapterFn();
        return json({
          adapter: adapter.capabilities.id,
          // Local DuckDB and MotherDuck share capabilities.id "duckdb"; surface the
          // deployment engine so the UI can label them apart (DuckDB vs MotherDuck).
          engine: env.warehouseAdapter,
          databaseTerm: adapter.capabilities.databaseTerm,
        });
      } catch (e) {
        console.error("✗ warehouse/info adapter unavailable:", e);
        return json({ error: "warehouse_unavailable" }, 503);
      }
    }

    // GET /api/warehouse/databases — list registered databases. Any authenticated user.
    if (seg[2] === "databases" && seg.length === 3 && method === "GET") {
      const { listWarehouseDatabases, refreshSchemaCounts, probeRegisteredDatabases } =
        await import("./repo-warehouse.ts");
      // Respond from Postgres immediately; re-snapshot the warehouse's schema
      // counts and reachability in the background so the next load reflects
      // any drift.
      void refreshSchemaCounts();
      void probeRegisteredDatabases();
      return json(await listWarehouseDatabases());
    }

    // GET /api/warehouse/databases/available — adapter-discovered databases with
    // a `registered` flag, so the Add picker can grey out already-added ones.
    if (seg[2] === "databases" && seg[3] === "available" && seg.length === 4 && method === "GET") {
      if (!sessionUser.isSuperAdmin)
        return json({ error: "forbidden", reason: "super_admin_required" }, 403);
      const { discoverDatabases } = await import("./repo-warehouse.ts");
      try {
        return json(await discoverDatabases());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("listDatabases exceeded"))
          return json({ kind: "DISCOVERY_TIMED_OUT" }, 504);
        throw err;
      }
    }

    // POST /api/warehouse/databases — super-admin picks one of the discovered
    // databases. No probe step: discovery already proved it exists.
    if (seg[2] === "databases" && seg.length === 3 && method === "POST") {
      if (!sessionUser.isSuperAdmin)
        return json({ error: "forbidden", reason: "super_admin_required" }, 403);
      const body = (await req.json()) as { databaseName: string; label?: string };
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(body.databaseName)) {
        return json({ kind: "INVALID_IDENTIFIER", databaseName: body.databaseName }, 422);
      }
      const { addWarehouseDatabase } = await import("./repo-warehouse.ts");
      const wd = await addWarehouseDatabase({
        databaseName: body.databaseName,
        label: body.label,
        actorUserId: me,
      });
      await appendAuditAs(me, "warehouse.database.add", body.databaseName, {
        metadata: { label: body.label ?? null, databaseId: wd.id },
      });
      return json(wd, 201);
    }

    // PATCH /api/warehouse/databases/:id — super-admin only
    if (seg[2] === "databases" && seg.length === 4 && method === "PATCH") {
      if (!sessionUser.isSuperAdmin)
        return json({ error: "forbidden", reason: "super_admin_required" }, 403);
      const body = (await req.json()) as { label?: string | null };
      if (body.label !== undefined) {
        const { updateDatabaseLabel } = await import("./repo-warehouse.ts");
        await updateDatabaseLabel(seg[3]!, body.label);
      }
      return noContent();
    }

    // DELETE /api/warehouse/databases/:id — super-admin only
    if (seg[2] === "databases" && seg.length === 4 && method === "DELETE") {
      if (!sessionUser.isSuperAdmin)
        return json({ error: "forbidden", reason: "super_admin_required" }, 403);
      const force = url.searchParams.get("force") === "true";
      const { removeDatabase } = await import("./repo-warehouse.ts");
      let out;
      try {
        out = await removeDatabase(seg[3]!, { force });
      } catch (removeErr) {
        const msg = removeErr instanceof Error ? removeErr.message : String(removeErr);
        if (msg === "DATABASE_NOT_FOUND") return json({ error: "DATABASE_NOT_FOUND" }, 404);
        throw removeErr;
      }
      if (!out.ok) {
        return json(
          { kind: "DATABASE_IN_USE", sourceCount: out.sourceCount, refTables: out.refTables },
          409,
        );
      }
      await appendAuditAs(me, "warehouse.database.remove", out.snapshot.databaseName, {
        metadata: {
          databaseName: out.snapshot.databaseName,
          databaseLabel: out.snapshot.label,
          forced: force,
          unboundSourceCount: out.snapshot.sourceCount,
        },
      });
      return noContent();
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
      serviceAccount: saCtx ?? undefined,
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

    // GET /api/t/:slug/drafts — one keyset-paginated page of workspace drafts
    // (boot path). The client pages through with ?cursor= until nextCursor is
    // null so no single request materializes an unbounded backlog (#151).
    if (
      tenantSlugFromPath !== null &&
      seg[1] === "drafts" &&
      seg.length === 2 &&
      method === "GET"
    ) {
      const cursor = url.searchParams.get("cursor");
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : undefined;
      return json(await reqRepo.listAllDraftsPage({ cursor, limit }));
    }

    // PATCH /api/t/:slug — rename workspace label and/or set color (admin only)
    if (tenantSlugFromPath !== null && seg.length === 1 && method === "PATCH") {
      const gate = requireAdmin(tenantCtx);
      if (!gate.ok) return json({ error: "forbidden" }, 403);
      const body = (await req.json()) as { label?: string; color?: string };
      if (typeof body.label === "string") {
        await updateTenantLabel(tenantCtx.tenantId, body.label);
        await appendAuditAs(me, "workspace.rename", `renamed workspace to "${body.label}"`, {
          tenantId: tenantCtx.tenantId,
          metadata: { actor_super_admin: gate.elevated },
        });
      }
      if (typeof body.color === "string") {
        await updateTenantColor(tenantCtx.tenantId, body.color);
      }
      return noContent();
    }

    // PATCH /api/t/:slug/slug — change URL slug (admin only; refuses on "default")
    if (
      tenantSlugFromPath !== null &&
      seg[1] === "slug" &&
      seg.length === 2 &&
      method === "PATCH"
    ) {
      const gate = requireAdmin(tenantCtx);
      if (!gate.ok) return json({ error: "forbidden" }, 403);
      const body = (await req.json()) as { slug?: string };
      if (typeof body.slug !== "string") {
        return json({ error: "slug required" }, 400);
      }
      const oldSlug = tenantSlugFromPath;
      try {
        await updateTenantSlug(oldSlug, body.slug);
      } catch (e) {
        if (e instanceof AppError) {
          return json({ error: e.code, message: e.message }, e.status);
        }
        throw e;
      }
      await appendAuditAs(
        me,
        "workspace.slug",
        `changed slug from "${oldSlug}" to "${body.slug.trim()}"`,
        {
          tenantId: tenantCtx.tenantId,
          metadata: {
            actor_super_admin: gate.elevated,
            old_slug: oldSlug,
            new_slug: body.slug.trim(),
          },
        },
      );
      return json({ ok: true, new_slug: body.slug.trim() });
    }

    // DELETE /api/t/:slug — delete workspace (admin only; refuses on "default")
    if (tenantSlugFromPath !== null && seg.length === 1 && method === "DELETE") {
      const gate = requireAdmin(tenantCtx);
      if (!gate.ok) return json({ error: "forbidden" }, 403);
      if (tenantSlugFromPath === "default") {
        return json({ error: "cannot_delete_default" }, 409);
      }
      // Scope this audit row to the "default" (system) tenant so it survives
      // teardownTenant() — which deletes audit_log rows for the target tenant.
      await appendAuditAs(
        me,
        "workspace.delete",
        `deleted workspace ${tenantSlugFromPath} (${tenantCtx.tenantId})`,
        {
          tenantId: "default",
          metadata: {
            actor_super_admin: gate.elevated,
            deleted_tenant_id: tenantCtx.tenantId,
            deleted_tenant_slug: tenantSlugFromPath,
          },
        },
      );
      await teardownTenant(tenantCtx.tenantId);
      return noContent();
    }

    // POST /api/t/:slug/leave — leave workspace (any member; last-admin guard)
    if (
      tenantSlugFromPath !== null &&
      seg[1] === "leave" &&
      seg.length === 2 &&
      method === "POST"
    ) {
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
        const gate = requireAdmin(tenantCtx);
        if (!gate.ok) return json({ error: "forbidden" }, 403);
        const body = (await req.json()) as { role: "admin" | "editor" | "viewer" };
        const targetUserId = decodeURIComponent(seg[3]!);
        const exists = (await listMembersForTenant(tenantCtx.tenantId)).find(
          (m) => m.user_id === targetUserId,
        );
        if (!exists) return json({ error: "not_found" }, 404);
        if (
          exists.role === "admin" &&
          body.role !== "admin" &&
          (await countAdmins(tenantCtx.tenantId)) <= 1
        ) {
          return json({ error: "last_admin" }, 409);
        }
        await setMemberRole(tenantCtx.tenantId, targetUserId, body.role);
        await appendAuditAs(me, "member.role", `set ${targetUserId} role to ${body.role}`, {
          tenantId: tenantCtx.tenantId,
          metadata: { actor_super_admin: gate.elevated, target_user_id: targetUserId },
        });
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      // DELETE /api/t/:slug/team/members/:userId
      if (seg[2] === "members" && seg.length === 4 && method === "DELETE") {
        const gate = requireAdmin(tenantCtx);
        if (!gate.ok) return json({ error: "forbidden" }, 403);
        const targetUserId = decodeURIComponent(seg[3]!);
        const targetRole = (await listMembersForTenant(tenantCtx.tenantId)).find(
          (m) => m.user_id === targetUserId,
        )?.role;
        if (targetRole === "admin" && (await countAdmins(tenantCtx.tenantId)) <= 1) {
          return json({ error: "last_admin" }, 409);
        }
        await removeMember(tenantCtx.tenantId, targetUserId);
        await appendAuditAs(me, "member.remove", `removed ${targetUserId}`, {
          tenantId: tenantCtx.tenantId,
          metadata: { actor_super_admin: gate.elevated, target_user_id: targetUserId },
        });
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      // GET /api/t/:slug/team/invites
      if (seg[2] === "invites" && seg.length === 3 && method === "GET") {
        return json(await listInvitesForTenant(tenantCtx.tenantId));
      }
      // POST /api/t/:slug/team/invites
      if (seg[2] === "invites" && seg.length === 3 && method === "POST") {
        const gate = requireAdmin(tenantCtx);
        if (!gate.ok) return json({ error: "forbidden" }, 403);
        const body = (await req.json()) as { email: string; role: "admin" | "editor" | "viewer" };
        let outcome;
        try {
          outcome = await addMemberOrInvite(tenantCtx.tenantId, body.email, body.role, me);
        } catch (e) {
          if (e instanceof AppError) {
            return json({ error: e.code, message: e.message }, e.status);
          }
          throw e;
        }
        const added = outcome.kind === "member";
        await appendAuditAs(
          me,
          added ? "member.add" : "invite.create",
          `${added ? "added" : "invited"} ${body.email} as ${body.role}`,
          {
            tenantId: tenantCtx.tenantId,
            metadata: { actor_super_admin: gate.elevated, invitee_email: body.email },
          },
        );
        return json({ ok: true, added }, 201);
      }
      // DELETE /api/t/:slug/team/invites/:email
      if (seg[2] === "invites" && seg.length === 4 && method === "DELETE") {
        const gate = requireAdmin(tenantCtx);
        if (!gate.ok) return json({ error: "forbidden" }, 403);
        const email = decodeURIComponent(seg[3]!);
        await revokeInvite(tenantCtx.tenantId, email);
        await appendAuditAs(me, "invite.revoke", `revoked invite for ${email}`, {
          tenantId: tenantCtx.tenantId,
          metadata: { actor_super_admin: gate.elevated, invitee_email: email },
        });
        return new Response(null, { status: 204, headers: corsHeaders });
      }
    }

    // /api/t/:slug/warehouse/tables — tenant-scoped warehouse table queries.
    if (tenantSlugFromPath !== null && seg[1] === "warehouse") {
      // GET /api/t/:slug/warehouse/tables — list tables in a database.
      if (seg[2] === "tables" && seg.length === 3 && method === "GET") {
        const databaseId = url.searchParams.get("database");
        if (!databaseId) return json({ error: "database query param required" }, 400);
        const { listWarehouseDatabases } = await import("./repo-warehouse.ts");
        const dbs = await listWarehouseDatabases();
        const db = dbs.find((d) => d.id === databaseId);
        if (!db) return json({ error: "database not found" }, 404);
        const { getAdapter: getAdapterFn } = await import("./warehouse/registry.ts");
        const adapter = await getAdapterFn();
        try {
          const tables = await adapter.listTables({
            database: db.databaseName,
            schema: url.searchParams.get("schema") ?? undefined,
            search: url.searchParams.get("search") ?? undefined,
          });
          return json(tables);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("listTables exceeded")) return json({ kind: "TABLES_TIMED_OUT" }, 504);
          throw err;
        }
      }

      // GET /api/t/:slug/warehouse/schemas — schema list with table counts.
      if (seg[2] === "schemas" && seg.length === 3 && method === "GET") {
        const databaseId = url.searchParams.get("database");
        if (!databaseId) return json({ error: "database query param required" }, 400);
        const { listWarehouseDatabases } = await import("./repo-warehouse.ts");
        const dbs = await listWarehouseDatabases();
        const db = dbs.find((d) => d.id === databaseId);
        if (!db) return json({ error: "database not found" }, 404);
        const { getAdapter: getAdapterFn } = await import("./warehouse/registry.ts");
        const adapter = await getAdapterFn();
        const tables = await adapter.listTables({ database: db.databaseName });
        const counts = new Map<string, number>();
        for (const t of tables) counts.set(t.schema, (counts.get(t.schema) ?? 0) + 1);
        const out = [...counts.entries()]
          .map(([schema, tables]) => ({ schema, tables }))
          .sort((a, b) => b.tables - a.tables || a.schema.localeCompare(b.schema));
        return json(out);
      }

      // GET /api/t/:slug/warehouse/columns?database=<id>&table=<schema.table> — columns + types.
      if (seg[2] === "columns" && seg.length === 3 && method === "GET") {
        const databaseId = url.searchParams.get("database");
        const tableParam = url.searchParams.get("table");
        if (!databaseId || !tableParam) return json({ error: "database and table required" }, 400);
        const dot = tableParam.indexOf(".");
        if (dot < 0) return json({ error: "table must be schema.table" }, 400);
        const schema = tableParam.slice(0, dot);
        const table = tableParam.slice(dot + 1);
        const { listWarehouseDatabases } = await import("./repo-warehouse.ts");
        const dbs = await listWarehouseDatabases();
        const db = dbs.find((d) => d.id === databaseId);
        if (!db) return json({ error: "database not found" }, 404);
        const { getAdapter: getAdapterFn } = await import("./warehouse/registry.ts");
        const adapter = await getAdapterFn();
        const ref = { catalog: db.databaseName, schema, table };
        const cols = await adapter.listColumns(ref);
        return json(cols.map((c) => ({ name: c.name, type: c.type })));
      }

      // GET /api/t/:slug/warehouse/values?database=<id>&table=<schema.table>&column=<c>&limit=<n> — sample values.
      if (seg[2] === "values" && seg.length === 3 && method === "GET") {
        const databaseId = url.searchParams.get("database");
        const tableParam = url.searchParams.get("table");
        const column = url.searchParams.get("column");
        if (!databaseId || !tableParam || !column)
          return json({ error: "database, table, column required" }, 400);
        const dot = tableParam.indexOf(".");
        if (dot < 0) return json({ error: "table must be schema.table" }, 400);
        const schema = tableParam.slice(0, dot);
        const table = tableParam.slice(dot + 1);
        const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") ?? 5) || 5));
        const { listWarehouseDatabases } = await import("./repo-warehouse.ts");
        const dbs = await listWarehouseDatabases();
        const db = dbs.find((d) => d.id === databaseId);
        if (!db) return json({ error: "database not found" }, 404);
        const { getAdapter: getAdapterFn } = await import("./warehouse/registry.ts");
        const adapter = await getAdapterFn();
        const ref = { catalog: db.databaseName, schema, table };
        const values = await adapter.distinctValues(ref, column, limit);
        return json({ values });
      }
    }

    // Liveness probe — hoisted OUT of pgTxScoped. A wedged warehouse ping must
    // not hold a tenant transaction; doing so would exhaust the pg pool.
    if (seg[1] === "health" && seg[2] === "connections" && seg.length === 3 && method === "GET") {
      const force = url.searchParams.get("force") === "1";
      const snapshot = await checkHealth({ force });
      return json(snapshot);
    }

    return await pgTxScoped(tenantCtx.tenantId, async () => {
      // GET /api/preferences ; PUT /api/preferences {publishThreshold, suggestThreshold, scanSchedule, requireSecondPublisher?, autoPublishEnabled?}
      if (seg[1] === "preferences" && seg.length === 2) {
        if (method === "GET") return json(await reqRepo.getPreferences());
        if (method === "PUT") {
          const denied = gateOrJson(tenantCtx, "manage_workspace");
          if (denied) return denied;
          const p = (await req.json()) as {
            publishThreshold: number;
            suggestThreshold: number;
            scanSchedule: "hourly" | "daily" | null;
            requireSecondPublisher?: boolean;
            autoPublishEnabled?: boolean;
          };
          await reqRepo.setPreferences({
            publishThreshold: p.publishThreshold,
            suggestThreshold: p.suggestThreshold,
            scanSchedule: p.scanSchedule,
            requireSecondPublisher: p.requireSecondPublisher ?? false,
            autoPublishEnabled: p.autoPublishEnabled ?? false,
          });
          return noContent();
        }
      }

      // GET /api/ai/status — whether any AI provider is set up for this
      // workspace. The Review page asks before rendering "Suggest with AI", so
      // a deployment with no AI shows no affordance instead of a retry loop.
      if (seg[1] === "ai" && seg[2] === "status" && seg.length === 3 && method === "GET") {
        return json({ configured: await isAIConfigured(tenantCtx.tenantId) });
      }

      if (seg[1] === "review" && seg[2] === "ai-hint" && seg.length === 3 && method === "GET") {
        const refTableId = url.searchParams.get("refTableId") ?? "";
        const raw = url.searchParams.get("raw") ?? "";
        if (!refTableId || !raw) return err("refTableId and raw required", 400);
        const refTable = await reqRepo.getRefTable(refTableId);
        if (!refTable) return json({ error: "not found" }, 404);
        if (!(await isAIConfigured(tenantCtx.tenantId)))
          return json({ error: "ai_not_configured" }, 503);
        try {
          const recordLabels = refTable.record.map((c) => c.label);
          const hint = await reqRepo.getAiHint(refTableId, raw, recordLabels, {
            label: refTable.refTable,
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
        const mine = users.find((u) => u.id === me) ?? users[0];
        return json({
          // Own email only — collaborators stay name + initials, never other
          // members' addresses.
          currentUser: mine && { ...mine, email: sessionUser.email },
          collaborators: users,
        });
      }

      // GET /api/workspace/info — adapter capability metadata for the frontend badge
      if (seg[1] === "workspace" && seg[2] === "info" && seg.length === 3 && method === "GET") {
        const { getAdapter: getAdapterFn } = await import("./warehouse/registry.ts");
        const adapterInstance = await getAdapterFn();
        return json({
          adapter: adapterInstance.capabilities.id,
          engine: env.warehouseAdapter,
          writable: adapterInstance.capabilities.writable,
          recordMode: adapterInstance.capabilities.writable ? "warehouse" : "postgres-export",
        });
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
          const denied = gateOrJson(tenantCtx, "manage_tables");
          if (denied) return denied;
          return json({ scanned: await reqRepo.scanSources() });
        }
        // GET /api/sources/unmapped?refTableId=&table=&column=&limit=
        if (seg[2] === "unmapped" && seg.length === 3 && method === "GET") {
          const refTableId = url.searchParams.get("refTableId") ?? "";
          const table = url.searchParams.get("table") ?? "";
          const column = url.searchParams.get("column") ?? "";
          const limit = Number(url.searchParams.get("limit") ?? 5);
          const databaseId = url.searchParams.get("databaseId") ?? undefined;
          if (!refTableId || !table || !column)
            return err("refTableId, table, column required", 400);
          return json(await reqRepo.topUnmapped(refTableId, table, column, limit, databaseId));
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
        if (method === "GET") {
          const sp = url.searchParams;
          return json(
            await reqRepo.listAudit(Number(sp.get("limit") ?? 30), {
              actor: sp.get("actor") ?? undefined,
              q: sp.get("q") ?? undefined,
              before: sp.get("before") ?? undefined,
            }),
          );
        }
        if (method === "POST") {
          const { action, detail } = (await req.json()) as { action: string; detail: string };
          await reqRepo.appendAudit(me, action, detail);
          return noContent();
        }
      }

      // GET / PATCH /api/grid-layout/:refTableId — per-user-per-refTable layout (widths/order/hidden)
      if (seg[1] === "grid-layout" && seg.length === 3) {
        const refTableId = decodeURIComponent(seg[2]!);
        if (method === "GET") return json(await reqRepo.getGridLayout(me, refTableId));
        if (method === "PATCH") {
          const body = (await req.json()) as GridLayoutConfig;
          await reqRepo.setGridLayout(me, refTableId, body);
          return noContent();
        }
      }

      if (seg[1] === "tables") {
        if (seg.length === 2 && method === "POST") {
          const denied = gateOrJson(tenantCtx, "manage_tables");
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
        // GET /api/tables/:id/records/:key/history?before=<cursor>&limit=<n>
        if (seg.length === 6 && seg[3] === "records" && seg[5] === "history" && method === "GET") {
          const tableId = decodeURIComponent(seg[2]!);
          const rowKey = decodeURIComponent(seg[4]!);
          const before = url.searchParams.get("before") ?? undefined;
          const limitParam = url.searchParams.get("limit");
          const limit = limitParam ? Number(limitParam) : undefined;
          const page = await reqRepo.listRecordHistory(tableId, rowKey, { before, limit });
          return json(page);
        }
        // Fall through to the shared table routes below (list/CRUD/sub-resources).
      }

      if (seg[1] === "tables") {
        // GET /api/tables[?full=true] ; POST /api/tables {name}
        // ?full=true returns the full MappingRefTable shapes (record rows,
        // values, fields, …) in one response — kills the N+1 the client used to
        // make at boot (1 list + N detail fetches).
        if (seg.length === 2) {
          if (method === "GET") {
            if (url.searchParams.get("full") === "true") {
              const metas = await reqRepo.listRefTables();
              const scalars = await reqRepo.getSourceScanScalars();
              const fulls = await Promise.all(
                metas.map(async (m) => {
                  const full = await reqRepo.getRefTable(m.id, { scalars });
                  if (!full) return null;
                  return { ...full, publish: await publishSummaryFor(m.id, tenantCtx.tenantId) };
                }),
              );
              return json(fulls.filter((d): d is NonNullable<typeof d> => d != null));
            }
            return json(await reqRepo.listRefTables());
          }
          // POST /api/tables (create) is handled by the orchestrator route above.
        }
        const id = seg[2] ? decodeURIComponent(seg[2]) : "";
        // GET /api/tables/:id
        if (seg.length === 3 && id && method === "GET") {
          const refTable = await reqRepo.getRefTable(id);
          // Carries `publish` like the ?full=true list route: the client swaps
          // the whole cached table in after every mutation, so leaving it out
          // blanked the Dashboard's publish summary until the next full load.
          return refTable
            ? json({ ...refTable, publish: await publishSummaryFor(id, tenantCtx.tenantId) })
            : json({ error: "not found" }, 404);
        }
        // GET /api/tables/:id/scan-values?filter=new|mapped|all&q=&after=&limit=
        if (seg[3] === "scan-values" && seg.length === 4 && id && method === "GET") {
          const filter = url.searchParams.get("filter") ?? "new";
          if (filter !== "new" && filter !== "mapped" && filter !== "all") {
            return json({ error: "invalid_filter" }, 400);
          }
          const q = url.searchParams.get("q");
          const after = url.searchParams.get("after");
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
          return json(await reqRepo.getSourceScanValuesPage(id, { filter, q, after, limit }));
        }
        // GET /api/tables/:id/clusters?filter=new|mapped|all
        if (seg[3] === "clusters" && seg.length === 4 && id && method === "GET") {
          const filter = url.searchParams.get("filter") ?? "new";
          if (filter !== "new" && filter !== "mapped" && filter !== "all") {
            return json({ error: "invalid_filter" }, 400);
          }
          return json(await reqRepo.getRefTableClusters(id, { filter }));
        }
        // POST /api/tables/:id/scan — rescan this refTable's wired sources and
        // re-materialize its source_scan_value rows. Faster than POST /api/sources/scan.
        if (seg[3] === "scan" && seg.length === 4 && id && method === "POST") {
          const denied = gateOrJson(tenantCtx, "manage_tables");
          if (denied) return denied;
          await reqRepo.scanOneDim(id);
          return json({ ok: true });
        }
        // GET /api/tables/:id/publish-state — version, last publish, pending work
        if (seg[3] === "publish-state" && seg.length === 4 && id && method === "GET") {
          return json(await reqRepo.getPublishState(id));
        }
        // GET /api/tables/:id/versions — published version history
        if (seg[3] === "versions" && seg.length === 4 && id && method === "GET") {
          return json(await reqRepo.listVersions(id));
        }
        // POST /api/tables/:id/rollback — restore a snapshotted version (admin only)
        if (seg[3] === "rollback" && seg.length === 4 && id && method === "POST") {
          const gate = requireAdmin(tenantCtx);
          if (!gate.ok) return json({ error: "forbidden" }, 403);
          const body = (await req.json()) as { toVersion?: unknown };
          const toVersion = Number(body?.toVersion);
          if (!Number.isInteger(toVersion) || toVersion < 1) {
            throw new AppError("VALIDATION_FAILED", "toVersion must be a positive integer", 400);
          }
          const { rollbackToVersion } = await import("./repo-rollback.ts");
          return json(await rollbackToVersion(id, tenantCtx.tenantId, toVersion, me));
        }
        // PATCH /api/tables/:id — update orderingMode / description / color / ownerUserId
        if (seg.length === 3 && id && method === "PATCH") {
          const denied = gateOrJson(tenantCtx, "curate");
          if (denied) return denied;
          const patch = (await req.json()) as import("./repo-record.ts").UpdateRefTableMetaInput;
          const refTable = await reqRepo.updateRefTableMeta(id, patch, me);
          return json({ ok: true, refTable });
        }
        // DELETE /api/tables/:id — permanently remove a table
        if (seg.length === 3 && id && method === "DELETE") {
          const denied = gateOrJson(tenantCtx, "manage_tables");
          if (denied) return denied;
          const ok = await reqRepo.deleteRefTable(id, me);
          return ok ? json({ ok: true }) : json({ error: "not found" }, 404);
        }
        if (seg[3] === "drafts") {
          // GET /api/tables/:id/drafts ; PUT (upsert) ; DELETE /.../:raw
          if (seg.length === 4 && method === "GET") return json(await reqRepo.listDrafts(id));
          if (seg.length === 4 && method === "PUT") {
            const denied = gateOrJson(tenantCtx, "curate");
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
            const denied = gateOrJson(tenantCtx, "curate");
            if (denied) return denied;
            // A draft is keyed per author, so a DELETE can legitimately match
            // nothing (someone else's draft for the same value). Report the
            // count instead of a 204 the client would read as success.
            return json(await reqRepo.discardDraft(id, decodeURIComponent(seg[4]!), me));
          }
          // POST /api/tables/:id/drafts/reject
          // { drafts: [{raw, userId?}] | raws: string[], reason }
          if (seg.length === 5 && seg[4] === "reject" && method === "POST") {
            const denied = gateOrJson(tenantCtx, "curate");
            if (denied) return denied;
            const b = (await req.json()) as {
              drafts?: unknown;
              raws?: unknown;
              reason: string;
            };
            const keys = draftSelectors(b.drafts ?? b.raws);
            if (!keys) return err("drafts must be an array", 400);
            if (typeof b.reason !== "string") return err("reason is required", 400);
            const result = await reqRepo.rejectDrafts(id, keys, b.reason, me);
            return json(result);
          }
        }
        // POST /api/tables/:id/sources — wire a warehouse column to a refTable.
        //   Qualified: { source: { databaseId, schemaName, tableName, columnName } }
        //   Bare:      { source: { table: "schema.table", column } }
        //              or { table: "schema.table", column }   (top-level bare)
        // Bare shapes resolve to the first registered warehouse_database via
        // resolveDefaultDatabase(). Bumps the user's MRU
        // (user_warehouse_state.recent_database_id) to the database written.
        if (seg[3] === "sources" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(tenantCtx, "manage_tables");
          if (denied) return denied;
          const raw = (await req.json()) as {
            source?: import("./repo-record.ts").QualifiedSource | { table: string; column: string };
            table?: string;
            column?: string;
          };
          const input =
            raw.source ??
            (raw.table && raw.column ? { table: raw.table, column: raw.column } : null);
          if (!input) return err("source required", 400);

          let qualified: import("./repo-record.ts").QualifiedSource;
          if ("databaseId" in input) {
            if (!input.databaseId || !input.schemaName || !input.tableName || !input.columnName) {
              return err("source requires databaseId + schemaName + tableName + columnName", 400);
            }
            qualified = input;
          } else {
            const parts = input.table.split(".");
            if (parts.length !== 2 || !parts[0] || !parts[1]) {
              return err(`expected "schema.table", got: ${input.table}`, 400);
            }
            const { resolveDefaultDatabase } = await import("./repo-record.ts");
            qualified = {
              databaseId: await resolveDefaultDatabase(tenantCtx.tenantId),
              schemaName: parts[0],
              tableName: parts[1],
              columnName: input.column,
            };
          }
          await pgRun(
            `INSERT INTO ${pg("reference_table_source")} (reference_table_id, tenant_id, database_id, schema_name, table_name, column_name)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant_id, reference_table_id, database_id, schema_name, table_name, column_name) DO NOTHING`,
            [
              id,
              tenantCtx.tenantId,
              qualified.databaseId,
              qualified.schemaName,
              qualified.tableName,
              qualified.columnName,
            ],
          );
          await pgRun(
            `INSERT INTO "zugzug_app"."user_warehouse_state" (tenant_id, user_id, recent_database_id, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (tenant_id, user_id) DO UPDATE
               SET recent_database_id = excluded.recent_database_id, updated_at = excluded.updated_at`,
            [tenantCtx.tenantId, me, qualified.databaseId],
          );
          return new Response(null, { status: 204, headers: corsHeaders });
        }
        // DELETE /api/tables/:id/sources — unwire a column. Same input
        // shapes as the POST above (bare "schema.table"+column resolves to the
        // default database; qualified passes databaseId explicitly).
        if (seg[3] === "sources" && seg.length === 4 && method === "DELETE") {
          const denied = gateOrJson(tenantCtx, "manage_tables");
          if (denied) return denied;
          const raw = (await req.json()) as {
            source?: import("./repo-record.ts").QualifiedSource | { table: string; column: string };
            table?: string;
            column?: string;
          };
          const input =
            raw.source ??
            (raw.table && raw.column ? { table: raw.table, column: raw.column } : null);
          if (!input) return err("source required", 400);

          const { resolveDefaultDatabase, removeSource } = await import("./repo-record.ts");
          let qualified: import("./repo-record.ts").QualifiedSource;
          if ("databaseId" in input) {
            if (!input.databaseId || !input.schemaName || !input.tableName || !input.columnName) {
              return err("source requires databaseId + schemaName + tableName + columnName", 400);
            }
            qualified = input;
          } else {
            const parts = input.table.split(".");
            if (parts.length !== 2 || !parts[0] || !parts[1]) {
              return err(`expected "schema.table", got: ${input.table}`, 400);
            }
            qualified = {
              databaseId: await resolveDefaultDatabase(tenantCtx.tenantId),
              schemaName: parts[0],
              tableName: parts[1],
              columnName: input.column,
            };
          }
          const removed = await removeSource(id, qualified, tenantCtx.tenantId);
          // 200 + {removed} rather than a blanket 204: the UI used to toast
          // "Removed …" for a DELETE that matched nothing (wrong database).
          return json({ removed });
        }
        // POST /api/tables/:id/derive {table, column, nameColumn?, databaseId?} — seed record.
        // databaseId names the warehouse database the caller browsed; without it
        // the wiring falls back to an existing registration for the same table,
        // then to the default database.
        if (seg[3] === "derive" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(tenantCtx, "curate");
          if (denied) return denied;
          const { table, column, nameColumn, force, databaseId } = (await req.json()) as {
            table: string;
            column: string;
            nameColumn?: string;
            force?: boolean;
            databaseId?: string;
          };
          return json(
            await reqRepo.deriveRecord(id, table, column, nameColumn, { force, databaseId }, me),
          );
        }
        // POST /api/tables/:id/import {rows} — bulk CSV import (create new keys, update fields on existing)
        if (seg[3] === "import" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(tenantCtx, "curate");
          if (denied) return denied;
          const { rows } = (await req.json()) as { rows: ImportRow[] };
          if (!Array.isArray(rows)) {
            throw new AppError("VALIDATION_FAILED", "rows must be an array", 400);
          }
          if (rows.length > 10_000) {
            throw new AppError("VALIDATION_FAILED", "too many rows (max 10000)", 400);
          }
          return json(await reqRepo.importRecord(id, rows, me));
        }
        // POST /api/tables/:id/fields {label, type?, options?, numberFormat?, ratingMax?, referencedRefTableId?, displayFields?} — add an attribute column
        if (seg[3] === "fields" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(tenantCtx, "manage_tables");
          if (denied) return denied;
          const {
            label,
            type,
            options,
            numberFormat,
            ratingMax,
            referencedRefTableId,
            displayFields,
            required,
            validation,
            formula,
          } = (await req.json()) as {
            label: string;
            type?: string;
            options?: { label: string; color: string | null }[];
            numberFormat?: NumberFormat;
            ratingMax?: number;
            referencedRefTableId?: string;
            displayFields?: string[];
            required?: boolean;
            validation?: {
              unique?: boolean;
              min?: number | string | null;
              max?: number | string | null;
            };
            formula?: {
              expr: string;
              resultType: "text" | "number" | "boolean";
              numberFormat?: NumberFormat;
            };
          };
          return json(
            await reqRepo.addField(
              id,
              label,
              type,
              options as OptionDef[] | undefined,
              {
                numberFormat,
                ratingMax,
                referencedRefTableId,
                displayFields,
                required,
                validation,
                formula,
              },
              me,
            ),
          );
        }
        // POST /api/tables/:id/formula/validate {expr, resultType} — parse + dry-run
        // a formula against one sample record so the field editor can show live
        // errors without shipping the evaluator to the browser.
        if (
          seg[3] === "formula" &&
          seg[4] === "validate" &&
          seg.length === 5 &&
          method === "POST"
        ) {
          const denied = gateOrJson(tenantCtx, "manage_tables");
          if (denied) return denied;
          const { expr } = (await req.json()) as { expr?: string };
          return json(await reqRepo.validateTableFormula(id, expr ?? "", me));
        }
        // POST /api/tables/:id/fields/:field/options {label} — append a select option
        if (seg[3] === "fields" && seg[5] === "options" && seg.length === 6 && method === "POST") {
          const denied = gateOrJson(tenantCtx, "curate");
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
        // PUT/PATCH/DELETE /api/tables/:id/fields/:field — rename / change type / update meta / delete
        if (seg[3] === "fields" && seg.length === 5) {
          const field = decodeURIComponent(seg[4]!);
          if (method === "PUT") {
            const denied = gateOrJson(tenantCtx, "manage_tables");
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
            const denied = gateOrJson(tenantCtx, "manage_tables");
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
            const denied = gateOrJson(tenantCtx, "manage_tables");
            if (denied) return denied;
            return json(await reqRepo.deleteColumn(id, field, me));
          }
        }
        // record record management
        if (seg[3] === "record") {
          if (seg.length === 4 && method === "POST") {
            const denied = gateOrJson(tenantCtx, "curate");
            if (denied) return denied;
            const { label, key, insertAt } = (await req.json()) as {
              label: string;
              key?: string;
              insertAt?: { anchor: string; direction: "above" | "below" };
            };
            if (insertAt) {
              await reqRepo.addRecordOneAt(id, label, key, insertAt, me);
            } else {
              await reqRepo.addRecordOne(id, label, key, me);
            }
            return noContent();
          }
          if (seg[4] === "merge" && seg.length === 5 && method === "POST") {
            const denied = gateOrJson(tenantCtx, "curate");
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
              merged: await reqRepo.mergeRecord(id, survivor, losers, me, expectedVersions),
            });
          }
          const ck = seg[4] ? decodeURIComponent(seg[4]) : "";
          if (seg[5] === "variants" && seg.length === 6 && method === "GET")
            return json(await reqRepo.listVariants(id, ck));
          // PUT /api/tables/:id/record/:key/field/:field {value}
          if (seg[5] === "field" && seg.length === 7 && method === "PUT") {
            const denied = gateOrJson(tenantCtx, "curate");
            if (denied) return denied;
            const { value } = (await req.json()) as { value: string | null };
            await reqRepo.setFieldValue(id, ck, decodeURIComponent(seg[6]!), value ?? null, me);
            return noContent();
          }
          // PUT /api/tables/:id/record/:key/position
          if (seg[5] === "position" && seg.length === 6 && method === "PUT" && ck) {
            const denied = gateOrJson(tenantCtx, "curate");
            if (denied) return denied;
            const { before, after } = (await req.json()) as {
              before?: string | null;
              after?: string | null;
            };
            try {
              const result = await reqRepo.reorderRecordRow(id, ck, before, after, me);
              return json({ ok: true, position: result.position });
            } catch (e) {
              if (e instanceof AppError && e.message.includes("positions too tight")) {
                const dm = await refTableMeta(id, tenantCtx.tenantId);
                if (dm)
                  await rebalanceRefTablePositions(id, dm, me, tenantCtx.tenantId, "collision");
                const result2 = await reqRepo.reorderRecordRow(id, ck, before, after, me);
                return json({ ok: true, position: result2.position, rebalanced: true });
              }
              throw e;
            }
          }
          if (seg.length === 5 && ck) {
            if (method === "PUT") {
              const denied = gateOrJson(tenantCtx, "curate");
              if (denied) return denied;
              const { label, expectedVersion } = (await req.json()) as {
                label: string;
                expectedVersion?: number;
              };
              if (typeof expectedVersion !== "number") {
                throw new AppError("VALIDATION_FAILED", "expectedVersion required", 400);
              }
              const result = await reqRepo.renameRecord(id, ck, label, me, expectedVersion);
              return json(result);
            }
            if (method === "DELETE") {
              const denied = gateOrJson(tenantCtx, "curate");
              if (denied) return denied;
              const ev = url.searchParams.get("expectedVersion");
              const expectedVersion = ev !== null ? Number(ev) : NaN;
              if (!Number.isFinite(expectedVersion)) {
                throw new AppError("VALIDATION_FAILED", "expectedVersion required", 400);
              }
              return json(await reqRepo.retireRecord(id, ck, me, expectedVersion));
            }
          }
        }
        // POST /api/tables/:id/commit
        if (seg[3] === "commit" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(tenantCtx, "commit");
          if (denied) return denied;
          const body = req.headers.get("content-length")
            ? ((await req.json().catch(() => null)) as { draftKeys?: unknown } | null)
            : null;
          const draftKeys = draftSelectors(body?.draftKeys) ?? undefined;
          return json(await reqRepo.commit(id, me, draftKeys));
        }
        // POST /api/tables/:id/revert — restore all changed records to the last published version
        if (seg[3] === "revert" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(tenantCtx, "curate");
          if (denied) return denied;
          return json(await reqRepo.revertToPublished(id, me));
        }
        // POST /api/tables/:id/positions/rebalance
        if (
          seg[3] === "positions" &&
          seg[4] === "rebalance" &&
          seg.length === 5 &&
          method === "POST"
        ) {
          const denied = gateOrJson(tenantCtx, "curate");
          if (denied) return denied;

          // Atomic rate-limit check-and-set: only proceeds if last rebalance was >60s ago
          const gateResult = await pgGet<{ last_rebalanced_at: string | null }>(
            `UPDATE ${pg("reference_table")}
                SET last_rebalanced_at = now()
              WHERE id = $1 AND tenant_id = $2
                AND (last_rebalanced_at IS NULL OR last_rebalanced_at < now() - interval '60 seconds')
              RETURNING last_rebalanced_at`,
            [id, tenantCtx.tenantId],
          );

          if (!gateResult) {
            const existing = await pgGet<{ last_rebalanced_at: string }>(
              `SELECT last_rebalanced_at FROM ${pg("reference_table")} WHERE id = $1 AND tenant_id = $2`,
              [id, tenantCtx.tenantId],
            );
            const lastMs = existing?.last_rebalanced_at
              ? new Date(existing.last_rebalanced_at).getTime()
              : 0;
            const retryAfter = Math.ceil((60_000 - (Date.now() - lastMs)) / 1000);
            return json(
              {
                // `code` is what the client branches on — without it the body
                // surfaced as a generic Error nobody caught.
                code: "REBALANCE_RATE_LIMITED",
                error: `Positions were just rebalanced — try again in ${Math.max(1, retryAfter)}s.`,
                lastRebalancedAt: existing?.last_rebalanced_at ?? null,
                retryAfterSeconds: Math.max(1, retryAfter),
              },
              429,
            );
          }

          const dm = await refTableMeta(id, tenantCtx.tenantId);
          if (!dm) return json({ error: "not found" }, 404);
          const rebalanced = await rebalanceRefTablePositions(
            id,
            dm,
            me,
            tenantCtx.tenantId,
            "manual",
          );
          return json({ ok: true, rebalanced, rebalancedAt: gateResult.last_rebalanced_at });
        }
        // POST /api/tables/:id/suggest {raw_value, force_refresh?} — AI suggestion
        if (seg[3] === "suggest" && seg.length === 4 && method === "POST") {
          const denied = gateOrJson(tenantCtx, "curate");
          if (denied) return denied;
          // Every call here can cost a paid provider call — force_refresh skips
          // the cache and guarantees one — so a looping client bills real money
          // rather than merely burning CPU. Budgeted per WORKSPACE because the
          // workspace is what pays: one member's runaway loop spends their own
          // allowance, not the deployment's. That does mean one member can use
          // up the shared budget for a minute; per-member fairness is a
          // separate concern from cost, and is not what this guards.
          const aiRate = await checkRateLimit(`ai:${tenantCtx.tenantId}`, env.aiRpm);
          if (!aiRate.ok) {
            return new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": String(aiRate.retryAfterSeconds),
                ...corsHeaders,
              },
            });
          }
          const body = (await req.json()) as {
            raw_value?: unknown;
            force_refresh?: unknown;
          };
          const rawValue = body.raw_value;
          const forceRefresh = body.force_refresh === true;
          if (typeof rawValue !== "string" || rawValue.length === 0) {
            return json(
              {
                error: "INVALID_REQUEST",
                detail: "source value is required and must be a string",
              },
              400,
            );
          }
          try {
            const refTable = await reqRepo.getRefTable(id);
            if (!refTable) {
              return json(
                {
                  error: "TABLE_NOT_FOUND",
                  detail: `Table ${id} not found in workspace`,
                },
                404,
              );
            }
            const suggestion = await generateSuggestion(
              tenantCtx.tenantId,
              {
                refTableId: id,
                refTableName: refTable.refTable,
                rawValue,
                existingRecordValues: refTable.record.slice(0, 30).map((c) => c.label),
              },
              { forceRefresh },
            );
            // Every publish path filters on target_key, so a draft without one
            // shows as ready but can never ship — and blocks the whole publish
            // when it's included. Only stage the mapping when the suggested
            // label resolves to a real record; otherwise hand the suggestion
            // back and let the user pick.
            const target = refTable.record.find((c) => c.label === suggestion.record);
            if (!target) {
              return json({
                draft_id: null,
                draft: null,
                suggestion: {
                  target_label: suggestion.record,
                  confidence: suggestion.confidence,
                  reasoning: suggestion.reasoning ?? null,
                },
                detail: `"${suggestion.record}" is not a record in this table — nothing was staged`,
                cached: suggestion.cached,
              });
            }
            const draft = await reqRepo.createDraft(
              {
                reference_table_id: id,
                raw: rawValue,
                target_label: target.label,
                target_key: target.key,
                source: "ai",
                confidence: suggestion.confidence,
                reasoning: suggestion.reasoning ?? null,
              },
              me,
            );
            return json(
              {
                draft_id: `${draft.refTableId}:${draft.raw}`,
                draft: {
                  reference_table_id: draft.refTableId,
                  raw: draft.raw,
                  status: draft.status,
                  target_label: draft.targetLabel,
                  target_key: draft.targetKey,
                  source: draft.source,
                  confidence: draft.confidence,
                  reasoning: draft.reasoning,
                  user: draft.user,
                  at: draft.at,
                },
                cached: suggestion.cached,
              },
              201,
            );
          } catch (e) {
            if (e instanceof AINotEnabledError) {
              return json(
                {
                  error: "AI_NOT_CONFIGURED",
                  detail: "AI suggestions aren't set up for this workspace",
                },
                400,
              );
            }
            if (e instanceof InvalidAPIKeyError) {
              return json(
                {
                  error: "INVALID_API_KEY",
                  detail: "AI provider API key is invalid or expired",
                },
                401,
              );
            }
            if (e instanceof RateLimitError) {
              return json(
                {
                  error: "RATE_LIMITED",
                  detail: "AI provider rate limit exceeded; try again in a few seconds",
                },
                429,
              );
            }
            if (e instanceof AIResponseParseError) {
              console.error("AI response parse error:", e.message);
              return json(
                {
                  error: "AI_RESPONSE_ERROR",
                  detail: "AI provider returned an unparseable response",
                },
                500,
              );
            }
            if (e instanceof AIProviderError) {
              console.error("AI provider error:", e.message);
              return json(
                {
                  error: "AI_SERVICE_ERROR",
                  detail: "AI service is temporarily unavailable; please try again",
                },
                500,
              );
            }
            throw e;
          }
        }
        // GET /api/tables/:id/snapshot.parquet — Parquet export of the refTable's map table
        if (seg[3] === "snapshot.parquet" && seg.length === 4 && method === "GET") {
          const refTableId = seg[2]!;
          const refTable = await reqRepo.getRefTable(refTableId);
          if (!refTable) return json({ error: "not found" }, 404);
          const { exportRecordToParquet } = await import("./warehouse/parquet-exporter.ts");
          const buf = await exportRecordToParquet({
            refTableId: refTable.id,
            dimTable: refTable.dimTable,
            mapTable: refTable.mapTable,
            keyCol: refTable.keyCol,
          });
          return new Response(buf, {
            status: 200,
            headers: {
              ...corsHeaders,
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${refTableId}-map.parquet"`,
              "cache-control": "no-store",
            },
          });
        }
      }

      // POST /api/e2e/seed-scan-values — E2E test helper: materialize source_scan_value
      // rows so the Review page has unmapped values without a live warehouse.
      // Workspace-admin gated. Body: { refTableId, occurrences: [{raw,table,column,rows}] }
      // Only available when ZUGZUG_E2E_TEST_ROUTES=1; absent in production.
      if (
        env.e2eTestRoutes &&
        seg[1] === "e2e" &&
        seg[2] === "seed-scan-values" &&
        method === "POST"
      ) {
        const denied = gateOrJson(tenantCtx, "manage_workspace");
        if (denied) return denied;
        const { materializeSourceScanValues } = await import("./repo-source-scan.ts");
        const body = (await req.json()) as {
          refTableId: string;
          occurrences: Array<{ raw: string; table: string; column: string; rows: number }>;
        };
        await materializeSourceScanValues(body.refTableId, tenantCtx.tenantId, {
          occurrences: body.occurrences,
          scannedAt: new Date(),
        });
        return json({ ok: true });
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
    captureError(e, { method, path: pathname });
    return err(e);
  }
}

if (import.meta.main) {
  initSentry();

  registerFactories({
    duckdb: async (creds) => createDuckDbAdapter(creds),
    snowflake: async (creds) => new SnowflakeAdapter(creds),
  });

  // Startup readiness probe — env-configured warehouse adapter.
  // Confirms the registry CAN talk to the warehouse before accepting traffic.
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
    // No tenant-level gate: each job decides for itself (SchedulerJob.shouldRun).
    // The scan cadence used to gate every job, so a workspace with scans "Off"
    // also lost auto-matching and auto-publishing.
    jobs: buildJobs(),
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
    hostname: env.host,
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
        captureError(e, { method: req.method, path: new URL(req.url).pathname });
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
    await flushSentry(2000);
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) =>
    captureError(reason, { kind: "unhandledRejection" }),
  );
  process.on("uncaughtException", (e) => {
    captureError(e, { kind: "uncaughtException" });
    void flushSentry(2000).finally(() => process.exit(1));
  });
}
