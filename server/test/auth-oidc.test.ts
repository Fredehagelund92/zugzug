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
import { provisionTenant, listMembershipsForUser } from "../src/tenant.ts";

// Fake Configuration — openid-client v6 functional API doesn't introspect
// the Configuration internals in tests, so a plain object is fine here.
const fakeConfig = {} as Parameters<
  typeof import("../src/auth-oidc.ts").setOidcConfigFactory
>[0] extends () => Promise<infer C>
  ? C
  : never;

let mockTokenResult: {
  claims: () => {
    sub: string;
    email?: string;
    name?: string;
    given_name?: string;
    family_name?: string;
  };
} | null = null;
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
  const req = new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state", {
    headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
  });
  const res = await handleOidcCallback(req);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/app");
  const setCookies = res.headers.getSetCookie();
  expect(setCookies.some((c) => c.includes("zz_sid="))).toBe(true);

  // First user should be seeded into default tenant as admin
  const member = await pgGet(
    `SELECT tm.role FROM ${pg("tenant_member")} tm
       JOIN ${pg("users")} u ON u.id = tm.user_id
      WHERE u.email = 'first@example.com' AND tm.tenant_id = 'default'`,
  );
  expect(member).not.toBeNull();
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
  const req = new Request("http://localhost/api/auth/oidc/callback?code=bad&state=test-state", {
    headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
  });
  const res = await handleOidcCallback(req);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("error=token");
});

// ---------------------------------------------------------------------------
// Test 4b: the user cancelled at the provider → error=no_code ("Login was
// cancelled."), not the generic "Authentication failed".
// ---------------------------------------------------------------------------

test("oidc callback — provider reports access_denied redirects with error=no_code", async () => {
  mockShouldThrow = new Error("should not reach the token exchange");
  const req = new Request(
    "http://localhost/api/auth/oidc/callback?error=access_denied&state=test-state",
    { headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" } },
  );
  const res = await handleOidcCallback(req);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("error=no_code");
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
    `SELECT role FROM ${pg("tenant_member")} WHERE user_id = 'u_sub-admin' AND tenant_id = 'default'`,
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

  // Invite second user via tenant_invite so they pass the gate
  await pgRun(
    `INSERT INTO ${pg("tenant_invite")} (tenant_id, email, role, invited_by, invited_at)
     VALUES ('default', 'second@example.com', 'editor', 'u_sub-first', now())
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
    `SELECT role FROM ${pg("tenant_member")} WHERE user_id = 'u_sub-second' AND tenant_id = 'default'`,
  );
  expect(user?.role).toBe("editor");
});

// ---------------------------------------------------------------------------
// Test 7b: an invited OIDC user joins only the inviting workspace
// ---------------------------------------------------------------------------

test("oidc callback — invited user joins ONLY the inviting workspace, not default", async () => {
  // First user bootstraps the default workspace as admin.
  mockTokenResult = {
    claims: () => ({ sub: "sub-boot", email: "boot@example.com", name: "Boot User" }),
  };
  await handleOidcCallback(
    new Request("http://localhost/api/auth/oidc/callback?code=abc&state=test-state", {
      headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
    }),
  );
  expect((await listMembershipsForUser("u_sub-boot")).map((m) => m.tenant.id)).toEqual(["default"]);

  // Second user is invited to toidc_x only.
  await provisionTenant({ id: "toidc_x", label: "Invite Target" });
  await pgRun(
    `INSERT INTO ${pg("tenant_invite")} (tenant_id, email, role, invited_by, invited_at)
     VALUES ('toidc_x', 'invitee@example.com', 'viewer', 'u_sub-boot', now())`,
  );
  mockTokenResult = {
    claims: () => ({ sub: "sub-invitee", email: "invitee@example.com", name: "Invitee" }),
  };
  const res = await handleOidcCallback(
    new Request("http://localhost/api/auth/oidc/callback?code=def&state=test-state", {
      headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" },
    }),
  );
  expect(res.status).toBe(302);

  const memberships = await listMembershipsForUser("u_sub-invitee");
  expect(memberships.map((m) => m.tenant.id)).toEqual(["toidc_x"]);
  expect(memberships[0]?.role).toBe("viewer");
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
    `INSERT INTO ${pg("users")} (id, name, email, initials, auth_provider)
     VALUES ('u_dummy', 'Dummy', 'dummy@example.com', 'DU', 'oidc')`,
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
    `SELECT role FROM ${pg("tenant_member")} WHERE user_id = 'u_sub-stays-admin' AND tenant_id = 'default'`,
  );
  expect(user?.role).toBe("admin");
});
