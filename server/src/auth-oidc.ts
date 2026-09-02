/* auth-oidc.ts — Generic OpenID Connect flow.
   Active when env.authMode === "oidc" (OIDC_ISSUER_URL is set).
   Uses openid-client v6 (functional API).

   Discovery is lazy + cached: the first OIDC request fetches the issuer's
   .well-known/openid-configuration and caches the Configuration.

   Test hooks: setOidcClient + setOidcConfigFactory allow full DI without
   mock.module — tests inject a fake OidcLib and/or a fake factory. */

import * as defaultClient from "openid-client";
import { env, pg } from "./env.ts";
import { pgTx } from "./pg.ts";
import { issueSession, countRealLoginUsers } from "./auth.ts";
import { acceptInvitesFor } from "./tenant.ts";
import { log } from "./log.ts";

// ---- DI types ---------------------------------------------------------------

type OidcLib = {
  discovery: typeof defaultClient.discovery;
  randomState: typeof defaultClient.randomState;
  randomNonce: typeof defaultClient.randomNonce;
  buildAuthorizationUrl: typeof defaultClient.buildAuthorizationUrl;
  authorizationCodeGrant: typeof defaultClient.authorizationCodeGrant;
};

// ---- injectable state -------------------------------------------------------

let _client: OidcLib = defaultClient;

let _configFactory: () => Promise<defaultClient.Configuration> = async () =>
  _client.discovery(new URL(env.oidcIssuerUrl), env.oidcClientId, env.oidcClientSecret);

let _cachedConfig: Promise<defaultClient.Configuration> | null = null;

// Domain getter — reads live from process.env so tests that set ALLOWED_DOMAIN
// before importing env.ts still see the correct value. env.allowedDomain is a
// static snapshot; this re-reads each request.
let _getAllowedDomain: () => string = () =>
  process.env.ALLOWED_DOMAIN?.trim() || process.env.OIDC_ALLOWED_DOMAIN?.trim() || "";

/** Test hook — override the allowed-domain getter. */
export function setAllowedDomainGetter(fn: () => string): void {
  _getAllowedDomain = fn;
}

/** Test hook — replace the entire openid-client surface. Clears the config cache. */
export function setOidcClient(client: OidcLib): void {
  _client = client;
  _cachedConfig = null;
}

/** Test hook — replace the Configuration factory. Clears the config cache. */
export function setOidcConfigFactory(f: () => Promise<defaultClient.Configuration>): void {
  _configFactory = f;
  _cachedConfig = null;
}

/** Test hook — reset the cached config (call in beforeEach). */
export function _resetOidcConfig(): void {
  _cachedConfig = null;
}

async function getOidcConfig(): Promise<defaultClient.Configuration> {
  if (!_cachedConfig) _cachedConfig = _configFactory();
  return _cachedConfig;
}

// ---- cookie helpers ---------------------------------------------------------

const STATE_COOKIE = "zz_oidc_state";
const NONCE_COOKIE = "zz_oidc_nonce";
const STATE_TTL_SECONDS = 600;

function isSecure(): boolean {
  return env.origin.startsWith("https://");
}

function shortCookie(name: string, value: string, maxAge: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure()) parts.push("Secure");
  return parts.join("; ");
}

function clearShortCookie(name: string): string {
  const base = `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
  return isSecure() ? `${base}; Secure` : base;
}

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

function loginErrorRedirect(error: string, ...clearCookies: string[]): Response {
  const headers = new Headers({ Location: `/login?${new URLSearchParams({ error })}` });
  for (const c of clearCookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

// ---- internal helpers -------------------------------------------------------

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "??"
  );
}

// ---- route handlers ---------------------------------------------------------

/** GET /api/auth/oidc/start — kick off the OIDC redirect. */
export async function handleOidcStart(_req: Request): Promise<Response> {
  const config = await getOidcConfig();
  const state = _client.randomState();
  const nonce = _client.randomNonce();
  const redirectUri = `${env.origin}/api/auth/oidc/callback`;

  const url = _client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: "openid profile email",
    state,
    nonce,
  });

  const headers = new Headers({ Location: url.toString() });
  headers.append("Set-Cookie", shortCookie(STATE_COOKIE, state, STATE_TTL_SECONDS));
  headers.append("Set-Cookie", shortCookie(NONCE_COOKIE, nonce, STATE_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

/** GET /api/auth/oidc/callback — provider redirects here after consent. */
export async function handleOidcCallback(req: Request): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const expectedState = cookies[STATE_COOKIE];
  const expectedNonce = cookies[NONCE_COOKIE];
  const clearState = clearShortCookie(STATE_COOKIE);
  const clearNonce = clearShortCookie(NONCE_COOKIE);

  if (!expectedState || !expectedNonce) {
    return loginErrorRedirect("state", clearState, clearNonce);
  }

  const callbackUrl = new URL(req.url);

  // A user who backs out at the provider comes back with ?error=access_denied
  // and no code. The grant below would report that as a generic failure, so
  // answer with the message that says what actually happened.
  if (callbackUrl.searchParams.get("error") === "access_denied") {
    return loginErrorRedirect("no_code", clearState, clearNonce);
  }

  const config = await getOidcConfig();

  let claims: {
    sub: string;
    email?: string;
    name?: string;
    given_name?: string;
    family_name?: string;
  };
  try {
    const tokens = await _client.authorizationCodeGrant(config, callbackUrl, {
      expectedState,
      expectedNonce,
    });
    claims = tokens.claims() as typeof claims;
  } catch (e) {
    console.warn(`oidc callback error: ${e instanceof Error ? e.message : String(e)}`);
    return loginErrorRedirect("token", clearState, clearNonce);
  }

  const sub = claims.sub;
  const email = (claims.email ?? "").toLowerCase();
  const name = claims.name ?? email;

  if (!email) return loginErrorRedirect("no_email", clearState, clearNonce);

  // Domain check — reads live from process.env via _getAllowedDomain() so that
  // test files that set ALLOWED_DOMAIN before imports still see the correct value.
  const allowedDomain = _getAllowedDomain();
  if (allowedDomain && email.split("@")[1] !== allowedDomain) {
    return loginErrorRedirect("domain", clearState, clearNonce);
  }

  const initials =
    claims.given_name && claims.family_name
      ? `${claims.given_name[0]}${claims.family_name[0]}`.toUpperCase()
      : initialsOf(name);

  const userId = `u_${sub}`;

  // Serialize the first-admin decision: same advisory lock key as auth-password.ts
  // so password and OIDC first-signups cannot race against each other.
  const oidcResult = await pgTx(async (tx) => {
    await tx.run(`SELECT pg_advisory_xact_lock(hashtext('zz:first-admin'))`);

    // Count only real login accounts — shared with auth-password.ts so seeded
    // placeholders (u_system, demo team) don't lock out the first real OIDC user.
    const userCount = await countRealLoginUsers(tx);

    // Gate check (with bootstrap: first OIDC user becomes admin).
    // Subsequent users must have a tenant_member or tenant_invite row.
    if (userCount > 0) {
      const allowed = await tx.get<{ ok: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM ${pg("tenant_member")} tm
             JOIN ${pg("users")} u ON u.id = tm.user_id
            WHERE u.email = $1
           UNION ALL
           SELECT 1 FROM ${pg("tenant_invite")} WHERE lower(email) = lower($1)
         ) AS ok`,
        [email],
      );
      if (!allowed?.ok) return { denied: true } as const;
    }

    // ON CONFLICT deliberately does NOT update role — an admin who re-logs in via
    // OIDC must stay admin; only the first-insert path sets the role.
    await tx.run(
      `INSERT INTO ${pg("users")} (id, name, email, google_sub, initials, auth_provider)
       VALUES ($1, $2, $3, $4, $5, 'oidc')
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         initials = EXCLUDED.initials,
         auth_provider = 'oidc'`,
      [userId, name, email, sub, initials],
    );

    // Bootstrap only: the very first account on a fresh install becomes admin of
    // the default workspace, otherwise the install is unusable. Everyone else
    // gets exactly the memberships their invites grant (acceptInvitesFor below).
    if (userCount === 0) {
      await tx.run(
        `INSERT INTO ${pg("tenant_member")} (tenant_id, user_id, role, created_at)
         VALUES ('default', $1, 'admin', now())
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [userId],
      );
    }

    return { denied: false } as const;
  });

  if (oidcResult.denied) {
    return loginErrorRedirect("not_allowed", clearState, clearNonce);
  }

  try {
    await acceptInvitesFor(userId, email);
  } catch (e) {
    log({ level: "error", msg: "accept-invites-failed", userId, err: String(e) });
  }

  const { cookie } = await issueSession(userId);
  const headers = new Headers({ Location: "/app" });
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", clearNonce);
  headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}
