/* v1-routes.ts — dispatch for /api/t/:slug/v1/...

   Composes:
     - authenticateBearer (auth-api-tokens.ts) — bearer-only on /v1/.
     - lookupAliasedSlug (slug-alias.ts) — 301 to current slug if applicable.
     - resolveTenantContext (tenant-middleware.ts) — SA-aware tenant binding.
     - checkRateLimit (rate-limit.ts) — per-credential budget.
     - repo-outbound.ts query helpers — wire-shape data fetches.
     - repo-service-accounts.ts CRUD helpers — admin-only mutations.

   Returns Response | null. Null means "not a /v1/ route — let the caller
   keep dispatching". */

import { authenticateBearer, type ServiceAccountCtx } from "./auth-api-tokens.ts";
import { getSessionUser } from "./auth.ts";
import { lookupAliasedSlug } from "./slug-alias.ts";
import { resolveTenantContext } from "./tenant-middleware.ts";
import { checkRateLimit } from "./rate-limit.ts";
import { env } from "./env.ts";
import {
  listDimensionsForApi,
  getSchemaForApi,
  listCanonicalPage,
  getCanonicalRow,
  listTombstonesPage,
  listEventsPage,
} from "./repo-outbound.ts";
import {
  createServiceAccount,
  listServiceAccounts,
  revokeServiceAccount,
} from "./repo-service-accounts.ts";
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  patchWebhook,
  deleteWebhook,
  rotateSecret,
  reactivateWebhook,
} from "./repo-webhooks.ts";
import {
  sendTestEvent,
  listDeliveries,
  getDelivery,
  replayDelivery,
} from "./repo-webhook-deliveries.ts";

const V1_PREFIX = /^\/api\/t\/([^/]+)\/v1(?:\/.*)?$/;

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function jsonError(status: number, error: string, retryAfter?: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter);
  return new Response(
    JSON.stringify({
      error,
      ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
    }),
    { status, headers },
  );
}

/** Returns Response if this is a /v1/ route (handled or rejected),
 *  null if the request is not under /api/t/:slug/v1/. */
export async function handleV1Route(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const m = V1_PREFIX.exec(url.pathname);
  if (!m) return null;
  const slugInPath = decodeURIComponent(m[1]!);

  // Alias redirect — BEFORE auth so we don't burn quota on stale URLs.
  const alias = await lookupAliasedSlug(slugInPath);
  if (alias && alias.currentSlug !== slugInPath) {
    const newPath = url.pathname.replace(
      `/api/t/${slugInPath}/`,
      `/api/t/${alias.currentSlug}/`,
    );
    return new Response(null, {
      status: 301,
      headers: { location: newPath + url.search },
    });
  }

  // Auth. Bearer (SA or personal token) is the primary path for /v1/. UI traffic
  // on cookies falls back so the same handlers serve both surfaces; SA-only
  // semantics (synthetic viewer role, scope gates) only kick in when the bearer
  // branch resolved a service account.
  let authed = await authenticateBearer(req);
  if (!authed) {
    const sessionUser = await getSessionUser(req);
    if (sessionUser) authed = { user: sessionUser };
  }
  if (!authed) return jsonError(401, "unauthorized");

  // Rate limit (per credential id).
  const credentialId = authed.serviceAccount
    ? `sa:${authed.serviceAccount.id}`
    : `usr:${authed.user.id}`;
  const budget = env.pullApiRpm ?? 600;
  const rate = await checkRateLimit(credentialId, budget);
  if (!rate.ok) return jsonError(429, "rate_limited", rate.retryAfterSeconds);

  // Tenant context (resolves SA tenant binding + role).
  let tenantCtx;
  try {
    tenantCtx = await resolveTenantContext({
      pathname: url.pathname,
      user: authed.user,
      isSuperAdmin: authed.user.isSuperAdmin,
      serviceAccount: authed.serviceAccount,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    const status = (e as { status?: number }).status;
    if (code === "NOT_FOUND" || status === 404) return jsonError(404, "tenant_not_found");
    if (code === "FORBIDDEN" || status === 403) return jsonError(403, "tenant_mismatch");
    return jsonError(500, "internal_error");
  }

  // Dispatch on path segments AFTER /v1/.
  const seg = url.pathname.split("/").filter(Boolean); // ["api","t",slug,"v1",...]
  const v1 = seg.slice(4); // segments after "v1"
  return await dispatch(req, url, v1, tenantCtx, authed.serviceAccount, authed.user.id);
}

async function dispatch(
  req: Request,
  url: URL,
  v1: string[],
  ctx: { tenantId: string; role: "admin" | "editor" | "viewer"; isSuperAdmin: boolean },
  sa: ServiceAccountCtx | undefined,
  userId: string,
): Promise<Response> {
  void sa;
  const method = req.method;

  // /v1/dimensions
  if (v1[0] === "dimensions" && v1.length === 1 && method === "GET") {
    return json(await listDimensionsForApi(ctx.tenantId));
  }

  // /v1/dimensions/:slug/schema
  if (v1[0] === "dimensions" && v1[2] === "schema" && v1.length === 3 && method === "GET") {
    const dimSlug = decodeURIComponent(v1[1]!);
    const out = await getSchemaForApi(ctx.tenantId, dimSlug);
    if (!out) return jsonError(404, "dimension_not_found");
    return json(out);
  }

  // /v1/dimensions/:slug/canonical
  if (v1[0] === "dimensions" && v1[2] === "canonical" && v1.length === 3 && method === "GET") {
    const dimSlug = decodeURIComponent(v1[1]!);
    const since = url.searchParams.get("since") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "");
    try {
      const out = await listCanonicalPage(ctx.tenantId, dimSlug, {
        since,
        cursor,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return json(out);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "cursor_invalid" || msg === "cursor_mismatch") return jsonError(400, msg);
      throw e;
    }
  }

  // /v1/dimensions/:slug/canonical/:key
  if (v1[0] === "dimensions" && v1[2] === "canonical" && v1.length === 4 && method === "GET") {
    const dimSlug = decodeURIComponent(v1[1]!);
    const key = decodeURIComponent(v1[3]!);
    const out = await getCanonicalRow(ctx.tenantId, dimSlug, key);
    if (!out) return jsonError(404, "not_found");
    return json(out);
  }

  // /v1/dimensions/:slug/tombstones
  if (v1[0] === "dimensions" && v1[2] === "tombstones" && v1.length === 3 && method === "GET") {
    const dimSlug = decodeURIComponent(v1[1]!);
    const since = url.searchParams.get("since") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "");
    try {
      const out = await listTombstonesPage(ctx.tenantId, dimSlug, {
        since,
        cursor,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return json(out);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "cursor_invalid" || msg === "cursor_mismatch") return jsonError(400, msg);
      throw e;
    }
  }

  // /v1/events
  if (v1[0] === "events" && v1.length === 1 && method === "GET") {
    const type = url.searchParams.get("type") ?? undefined;
    const since = url.searchParams.get("since") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "");
    try {
      const out = await listEventsPage(ctx.tenantId, {
        type,
        since,
        cursor,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return json(out);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "cursor_invalid" || msg === "cursor_mismatch") return jsonError(400, msg);
      throw e;
    }
  }

  // /v1/service-accounts (admin only)
  if (v1[0] === "service-accounts") {
    if (ctx.role !== "admin" && !ctx.isSuperAdmin) return jsonError(403, "admin_required");
    if (v1.length === 1 && method === "GET") {
      const list = await listServiceAccounts(ctx.tenantId);
      return json({ service_accounts: list });
    }
    if (v1.length === 1 && method === "POST") {
      let body: { name?: string; expires_at?: string | null };
      try {
        body = (await req.json()) as { name?: string; expires_at?: string | null };
      } catch {
        return jsonError(400, "invalid_json");
      }
      const name = (body.name ?? "").trim();
      if (!name) return jsonError(400, "name_required");
      const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
      const created = await createServiceAccount({
        tenantId: ctx.tenantId,
        name,
        createdBy: userId,
        expiresAt,
      });
      // value shown once.
      return json({ id: created.id, name, value: created.value, scopes: ["read"] }, 201);
    }
    if (v1.length === 2 && method === "DELETE") {
      const ok = await revokeServiceAccount(ctx.tenantId, decodeURIComponent(v1[1]!), userId);
      if (!ok) return jsonError(404, "not_found");
      return new Response(null, { status: 204 });
    }
  }

  // /v1/webhooks — admin-only for mutations; editor+ for reads
  if (v1[0] === "webhooks") {
    // GET /v1/webhooks — editor+
    if (v1.length === 1 && method === "GET") {
      if (ctx.role === "viewer") return jsonError(403, "editor_required");
      return json({ webhooks: await listWebhooks(ctx.tenantId) });
    }

    // POST /v1/webhooks — admin only
    if (v1.length === 1 && method === "POST") {
      if (ctx.role !== "admin" && !ctx.isSuperAdmin) return jsonError(403, "admin_required");
      let body: { url?: string; events?: string[]; description?: string | null };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError(400, "invalid_json");
      }
      try {
        const r = await createWebhook({
          tenantId: ctx.tenantId,
          url: body.url ?? "",
          events: body.events ?? [],
          description: body.description ?? null,
          createdBy: userId,
        });
        return json({ id: r.id, value: r.value }, 201);
      } catch (e) {
        const msg = (e as Error).message;
        if (
          msg === "invalid_url" ||
          msg === "https_required" ||
          msg === "events_empty" ||
          msg.startsWith("events_unknown")
        ) {
          return jsonError(400, msg);
        }
        throw e;
      }
    }

    // /v1/webhooks/:id
    if (v1.length === 2) {
      const id = decodeURIComponent(v1[1]!);
      if (method === "GET") {
        if (ctx.role === "viewer") return jsonError(403, "editor_required");
        const wh = await getWebhook(ctx.tenantId, id);
        return wh ? json(wh) : jsonError(404, "not_found");
      }
      if (method === "PATCH") {
        if (ctx.role !== "admin" && !ctx.isSuperAdmin) return jsonError(403, "admin_required");
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonError(400, "invalid_json");
        }
        try {
          const ok = await patchWebhook(ctx.tenantId, id, body, userId);
          return ok ? new Response(null, { status: 204 }) : jsonError(404, "not_found");
        } catch (e) {
          const msg = (e as Error).message;
          if (
            msg === "invalid_url" ||
            msg === "https_required" ||
            msg === "events_empty" ||
            msg === "status_invalid" ||
            msg === "status_disabled_not_allowed" ||
            msg.startsWith("events_unknown")
          ) {
            return jsonError(400, msg);
          }
          throw e;
        }
      }
      if (method === "DELETE") {
        if (ctx.role !== "admin" && !ctx.isSuperAdmin) return jsonError(403, "admin_required");
        const ok = await deleteWebhook(ctx.tenantId, id, userId);
        return ok ? new Response(null, { status: 204 }) : jsonError(404, "not_found");
      }
    }

    // /v1/webhooks/:id/{reactivate|rotate-secret|test|deliveries}
    if (v1.length === 3) {
      const id = decodeURIComponent(v1[1]!);
      const action = v1[2];
      if (action === "reactivate" && method === "POST") {
        if (ctx.role !== "admin" && !ctx.isSuperAdmin) return jsonError(403, "admin_required");
        const ok = await reactivateWebhook(ctx.tenantId, id, userId);
        return ok ? new Response(null, { status: 204 }) : jsonError(404, "not_found");
      }
      if (action === "rotate-secret" && method === "POST") {
        if (ctx.role !== "admin" && !ctx.isSuperAdmin) return jsonError(403, "admin_required");
        try {
          const r = await rotateSecret({ tenantId: ctx.tenantId, id, userId });
          return json({ value: r.value, previous_expires_at: r.previousExpiresAt });
        } catch (e) {
          if ((e as Error).message === "webhook_not_found") return jsonError(404, "not_found");
          throw e;
        }
      }
      if (action === "test" && method === "POST") {
        if (ctx.role !== "admin" && !ctx.isSuperAdmin) return jsonError(403, "admin_required");
        const r = await sendTestEvent(ctx.tenantId, id, userId);
        return r ? json(r) : jsonError(404, "not_found");
      }
      if (action === "deliveries" && method === "GET") {
        if (ctx.role === "viewer") return jsonError(403, "editor_required");
        const limitRaw = Number(url.searchParams.get("limit") ?? "");
        const out = await listDeliveries(ctx.tenantId, id, {
          status: url.searchParams.get("status") ?? undefined,
          limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
          role: ctx.role,
        });
        return json(out);
      }
    }
  }

  // /v1/webhook-deliveries/:id, /v1/webhook-deliveries/:id/replay
  if (v1[0] === "webhook-deliveries") {
    if (ctx.role === "viewer") return jsonError(403, "editor_required");
    if (v1.length === 2 && method === "GET") {
      const d = await getDelivery(ctx.tenantId, decodeURIComponent(v1[1]!), ctx.role);
      return d ? json(d) : jsonError(404, "not_found");
    }
    if (v1.length === 3 && v1[2] === "replay" && method === "POST") {
      if (ctx.role !== "admin" && !ctx.isSuperAdmin) return jsonError(403, "admin_required");
      const r = await replayDelivery(ctx.tenantId, decodeURIComponent(v1[1]!), userId);
      return r ? json({ delivery_id: r.id }, 202) : jsonError(404, "not_found");
    }
  }

  return jsonError(404, "route_not_found");
}
