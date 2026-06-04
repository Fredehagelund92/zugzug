/* auth.ts — Google OAuth2 flow + session resolution.
   Two public route handlers (handleGoogleRedirect, handleGoogleCallback,
   handleLogout, handleMe) plus getSessionUser() used as middleware in server.ts. */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { env, pg } from "./env.ts";
import { pgRun as run, pgAll as all, pgGet as get } from "./pg.ts";

export interface SessionUser { id: string; name: string; email: string; initials: string }

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const SID = "zz_sid";
const STATE = "zz_state";
const SESSION_SECONDS = 30 * 86_400;
const isSecure = env.origin.startsWith("https://");

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

function cookie(name: string, value: string, maxAge: number): string {
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
    `SELECT id, name, email, initials FROM ${pg("users")} WHERE id = $1`,
    [session.user_id],
  );
}

// ---- route handlers --------------------------------------------------------

/** GET /api/auth/google — kick off the OAuth2 redirect. */
export async function handleGoogleRedirect(_req: Request): Promise<Response> {
  const state = crypto.randomUUID().replace(/-/g, "");
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: `${env.origin}/api/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
  });
  const headers = new Headers({
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
  });
  headers.append("Set-Cookie", cookie(STATE, state, 600));
  return new Response(null, { status: 302, headers });
}

/** GET /api/auth/callback — Google redirects here after user consent. */
export async function handleGoogleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const cookies = parseCookies(req.headers.get("cookie"));

  const clearState = clearCookie(STATE);

  if (!stateParam || stateParam !== cookies[STATE]) {
    return loginError("state", clearState);
  }
  if (!code) return loginError("no_code", clearState);

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: `${env.origin}/api/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return loginError("token", clearState);
  const { id_token } = (await tokenRes.json()) as { id_token: string };

  // Verify ID token signature + claims
  let sub: string, email: string, name: string, givenName: string | undefined, familyName: string | undefined;
  try {
    const { payload } = await jwtVerify(id_token, GOOGLE_JWKS, {
      audience: env.googleClientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
    });
    sub = payload.sub as string;
    email = payload["email"] as string;
    name = (payload["name"] as string) ?? email;
    givenName = payload["given_name"] as string | undefined;
    familyName = payload["family_name"] as string | undefined;
  } catch {
    return loginError("token", clearState);
  }

  // Domain check
  if (email.split("@")[1] !== env.allowedDomain) return loginError("domain", clearState);

  // Allowlist check (empty table = bootstrap mode). ON CONFLICT DO NOTHING
  // makes the INSERT idempotent and closes the race where two simultaneous
  // first-logins both see n=0 — the second insert is a no-op, and both users
  // end up in the allowlist (both get in), which is the safe failure mode.
  const [{ n }] = await all<{ n: number }>(`SELECT count(*)::int AS n FROM ${pg("allowed_emails")}`);
  if (n === 0) {
    await run(
      `INSERT INTO ${pg("allowed_emails")} (email, added_by, added_at) VALUES ($1, 'bootstrap', current_timestamp) ON CONFLICT (email) DO NOTHING`,
      [email],
    );
  } else {
    const allowed = await get(`SELECT email FROM ${pg("allowed_emails")} WHERE email = $1`, [email]);
    if (!allowed) return loginError("not_allowed", clearState);
  }

  // Build initials from given/family name, fall back to splitting display name
  const initials = givenName && familyName
    ? `${givenName[0]}${familyName[0]}`.toUpperCase()
    : name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "??";

  // Upsert user
  const userId = `u_${sub}`;
  await run(
    `INSERT INTO ${pg("users")} (id, name, email, google_sub, initials)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET name = $2, email = $3, initials = $5`,
    [userId, name, email, sub, initials],
  );

  // Create session
  const sessionId = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
  await run(
    `INSERT INTO ${pg("sessions")} (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [sessionId, userId, expiresAt.toISOString()],
  );

  const headers = new Headers({ Location: "/app" });
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", cookie(SID, sessionId, SESSION_SECONDS));
  return new Response(null, { status: 302, headers });
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
  const cors = { "access-control-allow-origin": "*" };
  if (!user) return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", ...cors },
  });
  return new Response(JSON.stringify(user), {
    status: 200,
    headers: { "content-type": "application/json", ...cors },
  });
}

/** GET /api/auth/config — public config for the login page. */
export function handleAuthConfig(): Response {
  return new Response(JSON.stringify({ devBypass: env.devBypassAuth }), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

/** GET /api/auth/dev — one-click dev login; only works when devBypassAuth is true. */
export async function handleDevLogin(): Promise<Response> {
  const userId = "u_dev";
  await run(
    `INSERT INTO ${pg("users")} (id, name, email, initials)
     VALUES ($1, 'Dev User', 'dev@localhost', 'DV')
     ON CONFLICT (id) DO NOTHING`,
    [userId],
  );
  const sessionId = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
  await run(
    `INSERT INTO ${pg("sessions")} (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [sessionId, userId, expiresAt.toISOString()],
  );
  const headers = new Headers({ Location: "/app" });
  headers.append("Set-Cookie", cookie(SID, sessionId, SESSION_SECONDS));
  return new Response(null, { status: 302, headers });
}

// ---- internal helpers ------------------------------------------------------

function loginError(error: string, clearStateCookie: string): Response {
  const headers = new Headers({ Location: `/login?${new URLSearchParams({ error })}` });
  headers.append("Set-Cookie", clearStateCookie);
  return new Response(null, { status: 302, headers });
}
