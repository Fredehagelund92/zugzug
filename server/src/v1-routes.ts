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

  // Auth.
  const authed = await authenticateBearer(req);
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

  return jsonError(404, "route_not_found");
}
