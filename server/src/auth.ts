/* auth.ts — Shared auth infrastructure.

   This file holds:
     - SessionUser type
     - Cookie helpers (parse, build, clear)
     - getSessionUser middleware (used by every authenticated route)
     - issueSession helper (used by password + OIDC handlers)
     - handleAuthConfig + buildAuthConfig (returns mode + allowedDomain + oidcLabel for the Login page)
     - handleLogout / handleMe — generic, mode-agnostic
     - handleDevLogin — dev-only bypass for local testing

   Mode-specific handlers live in:
     - auth-password.ts   — local email + password (signup, login, change-password)
     - auth-oidc.ts       — generic OIDC via openid-client v6 (start, callback)
     - auth-api-tokens.ts — personal access tokens (list, create, revoke, bearer middleware)
*/

import { env, pg } from "./env.ts";
import { pgRun as run, pgGet as get, pgAll } from "./pg.ts";
import { AppError } from "./errors.ts";

export interface SessionUser {
  id: string;
  name: string;
  email: string | null; // null for service-account synthetic users
  initials: string;
  isSuperAdmin: boolean;
  /** Set by POST /api/admin/impersonate; only honored when isSuperAdmin is true. */
  impersonatingTenantId: string | null;
}

export type Role = "admin" | "editor" | "viewer";

export type Operation =
  | "curate" // create/update drafts
  | "commit" // commit drafts to canonical
  | "manage_adapter"; // configure warehouse credentials

/** Static permission matrix. Returns true if the given role may perform op. */
export function canMutate(role: Role, op: Operation): boolean {
  const matrix: Record<Role, Operation[]> = {
    admin: ["curate", "commit", "manage_adapter"],
    editor: ["curate", "commit"],
    viewer: [],
  };
  return matrix[role].includes(op);
}

const SID = "zz_sid";
const SESSION_SECONDS = 30 * 86_400;
const isSecure = env.origin.startsWith("https://");

const cors = {
  "access-control-allow-origin": env.origin,
  "access-control-allow-credentials": "true",
  vary: "Origin",
};

// ---- cookie helpers --------------------------------------------------------

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, maxAge: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name: string): string {
  const base = `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
  return isSecure ? `${base}; Secure` : base;
}

// ---- session ---------------------------------------------------------------

/** Read the zz_sid cookie and return the associated user, or null. */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const sid = cookies[SID];
  if (!sid) return null;
  const session = await get<{ user_id: string; expires_at: string }>(
    `SELECT user_id, expires_at FROM ${pg("sessions")} WHERE id = $1`,
    [sid],
  );
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    await run(`DELETE FROM ${pg("sessions")} WHERE id = $1`, [sid]);
    return null;
  }
  return get<SessionUser>(
    `SELECT u.id, u.name, u.email, u.initials,
            u.is_super_admin AS "isSuperAdmin",
            a.impersonating_tenant_id AS "impersonatingTenantId"
       FROM ${pg("users")} u
  LEFT JOIN ${pg("active_sessions")} a ON a.user_id = u.id
      WHERE u.id = $1`,
    [session.user_id],
  );
}

/** Create a session row for the user and return the matching Set-Cookie header.
 *  Used by both password (signup, login) and OIDC (callback) handlers. */
export async function issueSession(userId: string): Promise<{ sessionId: string; cookie: string }> {
  const sessionId = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
  await run(`INSERT INTO ${pg("sessions")} (id, user_id, expires_at) VALUES ($1, $2, $3)`, [
    sessionId,
    userId,
    expiresAt.toISOString(),
  ]);
  return { sessionId, cookie: cookie(SID, sessionId, SESSION_SECONDS) };
}

// ---- generic route handlers (mode-agnostic) --------------------------------

export interface AuthConfigBody {
  mode: "password" | "oidc";
  signupOpen: boolean;
  allowedDomain: string | null;
  oidcLabel?: string;
}

export function buildAuthConfig(input: {
  authMode: "password" | "oidc";
  allowedDomain: string;
  oidcLabel: string;
}): AuthConfigBody {
  const body: AuthConfigBody = {
    mode: input.authMode,
    signupOpen: false, // Reserved for v1.1 OPEN_SIGNUP=true env flag.
    allowedDomain: input.allowedDomain || null,
  };
  if (input.authMode === "oidc" && input.oidcLabel) {
    body.oidcLabel = input.oidcLabel;
  }
  return body;
}

/** GET /api/auth/config — public config for the login page (mode, allowedDomain, oidcLabel). */
export function handleAuthConfig(): Response {
  const body = buildAuthConfig({
    authMode: env.authMode,
    allowedDomain: env.allowedDomain,
    oidcLabel: env.oidcLabel,
  });
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...cors },
  });
}

/** POST /api/auth/logout — delete session + clear cookie. */
export async function handleLogout(req: Request): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const sid = cookies[SID];
  if (sid) await run(`DELETE FROM ${pg("sessions")} WHERE id = $1`, [sid]);
  const headers = new Headers({ Location: "/login" });
  headers.append("Set-Cookie", clearCookie(SID));
  return new Response(null, { status: 302, headers });
}

/** GET /api/auth/me — return session user or 401. Used by BootGate. */
export async function handleMe(req: Request): Promise<Response> {
  const user = await getSessionUser(req);
  if (!user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", ...cors },
    });
  // Best-effort — fire-and-forget, never blocks the response.
  void run(`UPDATE ${pg("users")} SET last_seen_at = now() WHERE id = $1`, [user.id]).catch(
    () => {},
  );
  return new Response(JSON.stringify(user), {
    status: 200,
    headers: { "content-type": "application/json", ...cors },
  });
}

/** GET /api/auth/dev — one-click dev login; only works when devBypassAuth is true. */
export async function handleDevLogin(): Promise<Response> {
  const userId = "u_dev";
  await run(
    `INSERT INTO ${pg("users")} (id, name, email, initials, auth_provider, is_super_admin)
     VALUES ($1, 'Dev User', 'dev@localhost', 'DV', 'password', true)
     ON CONFLICT (id) DO UPDATE SET is_super_admin = true`,
    [userId],
  );
  const { cookie: setCookie } = await issueSession(userId);
  const headers = new Headers({ Location: "/app" });
  headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

/** Updates the display name for an authenticated user. Throws AppError on empty name. */
export async function updateUserName(userId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "name cannot be empty", 400);
  await run(`UPDATE ${pg("users")} SET name = $1 WHERE id = $2`, [trimmed, userId]);
}

export interface AdminUserRecord {
  id: string;
  email: string | null;
  name: string;
  initials: string;
  isSuperAdmin: boolean;
  lastSeenAt: string | null;
  membershipCount: number;
}

export async function listUsers(q?: string, limit = 50, offset = 0): Promise<AdminUserRecord[]> {
  const params: unknown[] = [limit, offset];
  const filter = q ? `WHERE (u.email ILIKE $3 OR u.name ILIKE $3)` : "";
  if (q) params.push(`%${q}%`);
  return pgAll<AdminUserRecord>(
    `SELECT u.id, u.email, u.name, u.initials,
            u.is_super_admin AS "isSuperAdmin",
            u.last_seen_at AS "lastSeenAt",
            COUNT(tm.user_id)::int AS "membershipCount"
       FROM ${pg("users")} u
       LEFT JOIN ${pg("tenant_member")} tm ON tm.user_id = u.id
       ${filter}
       GROUP BY u.id
       ORDER BY u.name
       LIMIT $1 OFFSET $2`,
    params,
  );
}

export interface TenantAuthContext {
  tenantId: string;
  role: "admin" | "editor" | "viewer";
  isSuperAdmin: boolean;
}

/**
 * Authorization check for workspace-admin mutations.
 * Super-admin entering a workspace as a non-admin member is elevated to admin.
 * Returns { ok, elevated } so callers can tag the audit log.
 */
export function requireAdmin(
  ctx: TenantAuthContext,
): { ok: true; elevated: boolean } | { ok: false } {
  if (ctx.role === "admin") return { ok: true, elevated: false };
  if (ctx.isSuperAdmin) return { ok: true, elevated: true };
  return { ok: false };
}

export type Scope = "read" | "webhook:manage";

export interface ScopedRequest {
  serviceAccount?: { scopes: string[] };
}

/** Pre-role gate for SA requests. If the caller is NOT a service account
 *  (i.e. cookie or personal-token authenticated), the scope check is a
 *  no-op — the existing role gates take over. SA tokens must carry the
 *  scope explicitly OR the route returns 403 scope_insufficient. */
export function requireScope(
  req: ScopedRequest,
  required: Scope,
): { ok: true } | { ok: false; status: 403; error: "scope_insufficient" } {
  if (!req.serviceAccount) return { ok: true };
  if (req.serviceAccount.scopes.includes(required)) return { ok: true };
  return { ok: false, status: 403, error: "scope_insufficient" };
}

export async function countSuperAdmins(): Promise<number> {
  const row = await get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${pg("users")} WHERE is_super_admin = true`,
    [],
  );
  return row?.n ?? 0;
}

export async function setSuperAdmin(
  targetId: string,
  callerId: string,
  value: boolean,
): Promise<void> {
  if (!value && targetId === callerId) {
    throw new AppError("SELF_DEMOTE", "cannot demote yourself", 409);
  }
  if (!value && (await countSuperAdmins()) <= 1) {
    throw new AppError("LAST_SUPER_ADMIN", "cannot demote the last super-admin", 409);
  }
  await run(`UPDATE ${pg("users")} SET is_super_admin = $1 WHERE id = $2`, [value, targetId]);
}
