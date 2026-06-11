/* auth-oidc.ts — Generic OpenID Connect flow.
   Active when env.authMode === "oidc" (OIDC_ISSUER_URL is set).
   Uses openid-client v6 (functional API).

   Discovery is lazy + cached: the first OIDC request fetches the issuer's
   .well-known/openid-configuration and caches the Configuration.

   Test hooks: setOidcClient + setOidcConfigFactory allow full DI without
   mock.module — tests inject a fake OidcLib and/or a fake factory. */

import * as defaultClient from "openid-client";
import { env, pg } from "./env.ts";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import { issueSession } from "./auth.ts";
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

  const config = await getOidcConfig();
  const callbackUrl = new URL(req.url);

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

  // Allowlist check (with bootstrap: first OIDC user becomes admin)
  const [{ n: userCount }] = await pgAll<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${pg("users")}`,
  );
  if (userCount === 0) {
    await pgRun(
      `INSERT INTO ${pg("allowed_emails")} (email, added_by, added_at)
       VALUES ($1, 'bootstrap', current_timestamp)
       ON CONFLICT (email) DO NOTHING`,
      [email],
    );
  } else {
    const allowed = await pgGet(`SELECT email FROM ${pg("allowed_emails")} WHERE email = $1`, [
      email,
    ]);
    if (!allowed) {
      return loginErrorRedirect("not_allowed", clearState, clearNonce);
    }
  }

  // NOTE: userCount===0 is race-vulnerable under concurrent first-logins — both
  // could see count=0 and both become admin. Acceptable for v0.2; no lock added.
  const role = userCount === 0 ? "admin" : "editor";

  const initials =
    claims.given_name && claims.family_name
      ? `${claims.given_name[0]}${claims.family_name[0]}`.toUpperCase()
      : initialsOf(name);

  const userId = `u_${sub}`;
  // ON CONFLICT deliberately does NOT update role — an admin who re-logs in via
  // OIDC must stay admin; only the first-insert path sets the role.
  await pgRun(
    `INSERT INTO ${pg("users")} (id, name, email, google_sub, initials, auth_provider, role)
     VALUES ($1, $2, $3, $4, $5, 'oidc', $6)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       initials = EXCLUDED.initials,
       auth_provider = 'oidc'`,
    [userId, name, email, sub, initials, role],
  );

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
