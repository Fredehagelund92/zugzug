process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.OIDC_ISSUER_URL = "https://example-issuer.test";
process.env.OIDC_CLIENT_ID = "test-client-id";
process.env.OIDC_CLIENT_SECRET = "test-client-secret";
process.env.ALLOWED_DOMAIN = ""; // no domain restriction for these tests

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import {
  handleOidcStart,
  handleOidcCallback,
  setOidcClient,
  setOidcConfigFactory,
  _resetOidcConfig,
} from "../src/auth-oidc.ts";
import { pgGet, pgRun } from "../src/pg.ts";
import { pg } from "../src/env.ts";

// Fake Configuration — openid-client v6 functional API doesn't introspect
// the Configuration internals in tests, so a plain object is fine here.
const fakeConfig = {} as Parameters<typeof import("../src/auth-oidc.ts").setOidcConfigFactory>[0] extends () => Promise<infer C> ? C : never;

let mockTokenResult: { claims: () => { sub: string; email?: string; name?: string; given_name?: string; family_name?: string } } | null =
  null;
let mockShouldThrow: Error | null = null;

// Fake openid-client implementation — no network, fully deterministic.
const fakeClient = {
  discovery: async () => fakeConfig,
  randomState: () => "test-state",
  randomNonce: () => "test-nonce",
  buildAuthorizationUrl: (_config: unknown, params: Record<string, string>) => {
    const u = new URL("https://example-issuer.test/authorize");
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
  },
  authorizationCodeGrant: async () => {
    if (mockShouldThrow) throw mockShouldThrow;
    if (!mockTokenResult) throw new Error("no mock token result configured");
    return mockTokenResult;
  },
} as Parameters<typeof setOidcClient>[0];

beforeEach(async () => {
  await resetDb();
  _resetOidcConfig();
  setOidcClient(fakeClient);
  setOidcConfigFactory(async () => fakeConfig);
  mockTokenResult = null;
  mockShouldThrow = null;
});

// ---------------------------------------------------------------------------
// Test 1: oidc start
// ---------------------------------------------------------------------------

test("oidc start — 302 to authorize URL with state + nonce cookies set", async () => {
  const res = await handleOidcStart(new Request("http://localhost/api/auth/oidc/start"));
  expect(res.status).toBe(302);
  const location = res.headers.get("Location") ?? "";
  expect(location).toContain("https://example-issuer.test/authorize");
  expect(location).toContain("state=test-state");
  const setCookies = res.headers.getSetCookie();
  expect(setCookies.some((c) => c.startsWith("zz_oidc_state=test-state"))).toBe(true);
  expect(setCookies.some((c) => c.startsWith("zz_oidc_nonce=test-nonce"))).toBe(true);
  // Cookies should have Max-Age=600
  expect(setCookies.some((c) => c.includes("Max-Age=600") && c.includes("zz_oidc_state"))).toBe(
    true,
  );
});

// ---------------------------------------------------------------------------
// Test 2: valid token — first user becomes admin, session set
// ---------------------------------------------------------------------------

test("oidc callback — valid token, first user becomes admin, session cookie set", async () => {
  mockTokenResult = {
    claims: () => ({
      sub: "user-sub-1",
      email: "first@example.com",
      name: "Ada Lovelace",
      given_name: "Ada",
      family_name: "Lovelace",
    }),
  };
  const req = new Request(
    "http://localhost/api/auth/oidc/callback?code=abc&state=test-state",
    { headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" } },
  );
  const res = await handleOidcCallback(req);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/app");
  const setCookies = res.headers.getSetCookie();
  expect(setCookies.some((c) => c.includes("zz_sid="))).toBe(true);

  // First user should be bootstrapped into allowed_emails
  const allowed = await pgGet(
    `SELECT email FROM ${pg("allowed_emails")} WHERE email = 'first@example.com'`,
  );
  expect(allowed).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Test 3: missing state cookie → error=state
// ---------------------------------------------------------------------------

test("oidc callback — missing state cookie redirects with error=state", async () => {
  const req = new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state");
  const res = await handleOidcCallback(req);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("error=state");
});

// ---------------------------------------------------------------------------
// Test 4: token-exchange throws → error=token
// ---------------------------------------------------------------------------

test("oidc callback — token-exchange failure redirects with error=token", async () => {
  mockShouldThrow = new Error("simulated token exchange failure");
  const req = new Request(
    "http://localhost/api/auth/oidc/callback?code=bad&state=test-state",
    { headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" } },
  );
  const res = await handleOidcCallback(req);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("error=token");
});

// ---------------------------------------------------------------------------
// Test 5: upserts existing user by sub (creates first, updates name on second)
// ---------------------------------------------------------------------------

test("oidc callback — upserts existing user by sub", async () => {
  // First callback creates the user
  mockTokenResult = {
    claims: () => ({ sub: "user-sub-3", email: "upsert@example.com", name: "Old Name" }),
  };
  await handleOidcCallback(
    new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state", {
      headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
    }),
  );

  // Second callback updates the name
  mockTokenResult = {
    claims: () => ({ sub: "user-sub-3", email: "upsert@example.com", name: "New Name" }),
  };
  const res = await handleOidcCallback(
    new Request("http://localhost/api/auth/oidc/callback?code=def&state=test-state", {
      headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
    }),
  );
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/app");

  // Verify the user's name was updated and auth_provider is 'oidc'
  const user = await pgGet<{ name: string; auth_provider: string }>(
    `SELECT name, auth_provider FROM ${pg("users")} WHERE id = 'u_user-sub-3'`,
  );
  expect(user?.name).toBe("New Name");
  expect(user?.auth_provider).toBe("oidc");
});

// ---------------------------------------------------------------------------
// Test 6: first OIDC user gets role='admin'
// ---------------------------------------------------------------------------

test("oidc callback — first user gets role='admin'", async () => {
  mockTokenResult = {
    claims: () => ({ sub: "sub-admin", email: "admin@example.com", name: "Admin User" }),
  };
  const res = await handleOidcCallback(
    new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state", {
      headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
    }),
  );
  expect(res.status).toBe(302);
  const user = await pgGet<{ role: string }>(
    `SELECT role FROM ${pg("users")} WHERE id = 'u_sub-admin'`,
  );
  expect(user?.role).toBe("admin");
});

// ---------------------------------------------------------------------------
// Test 7: second OIDC user gets role='editor'
// ---------------------------------------------------------------------------

test("oidc callback — second user gets role='editor'", async () => {
  // First user (becomes admin + bootstraps allowlist)
  mockTokenResult = {
    claims: () => ({ sub: "sub-first", email: "first@example.com", name: "First User" }),
  };
  await handleOidcCallback(
    new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state", {
      headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
    }),
  );

  // Add second user to allowlist
  await pgRun(
    `INSERT INTO ${pg("allowed_emails")} (email, added_by, added_at)
     VALUES ('second@example.com', 'admin', current_timestamp)
     ON CONFLICT DO NOTHING`,
  );

  // Second user
  mockTokenResult = {
    claims: () => ({ sub: "sub-second", email: "second@example.com", name: "Second User" }),
  };
  const res = await handleOidcCallback(
    new Request("http://localhost/api/auth/oidc/callback?code=def&state=test-state", {
      headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
    }),
  );
  expect(res.status).toBe(302);
  const user = await pgGet<{ role: string }>(
    `SELECT role FROM ${pg("users")} WHERE id = 'u_sub-second'`,
  );
  expect(user?.role).toBe("editor");
});

// ---------------------------------------------------------------------------
// Test 8: returning OIDC user does NOT have role overwritten by ON CONFLICT
// ---------------------------------------------------------------------------

test("oidc callback — re-login does not overwrite existing role", async () => {
  // First login (creates user as admin)
  mockTokenResult = {
    claims: () => ({ sub: "sub-stays-admin", email: "stays@example.com", name: "Stays Admin" }),
  };
  await handleOidcCallback(
    new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state", {
      headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
    }),
  );

  // Manually promote to verify by checking initial state, then simulate a second
  // user existing so the re-login would compute role='editor' if it re-ran the logic.
  // Insert a second user to make userCount > 0 for the re-login.
  await pgRun(
    `INSERT INTO ${pg("users")} (id, name, email, initials, auth_provider, role)
     VALUES ('u_dummy', 'Dummy', 'dummy@example.com', 'DU', 'oidc', 'editor')`,
  );

  // Re-login for the same user — userCount is now 2, so role computed as 'editor'.
  // The ON CONFLICT path must NOT update role.
  mockTokenResult = {
    claims: () => ({ sub: "sub-stays-admin", email: "stays@example.com", name: "Stays Admin" }),
  };
  await handleOidcCallback(
    new Request("http://localhost/api/auth/oidc/callback?code=xyz&state=test-state", {
      headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
    }),
  );

  // Role must still be admin despite re-login when userCount > 0
  const user = await pgGet<{ role: string }>(
    `SELECT role FROM ${pg("users")} WHERE id = 'u_sub-stays-admin'`,
  );
  expect(user?.role).toBe("admin");
});
