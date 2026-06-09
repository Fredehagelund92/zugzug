process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
delete process.env.OIDC_ISSUER_URL;
process.env.ALLOWED_DOMAIN = "";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import {
  handleCreateToken,
  handleListTokens,
  handleRevokeToken,
  getApiTokenUser,
} from "../src/auth-api-tokens.ts";
import { handleSignup } from "../src/auth-password.ts";
import { pgGet } from "../src/pg.ts";

beforeEach(async () => {
  await resetDb();
});

async function newUser(email = "u@example.com"): Promise<string> {
  const res = await handleSignup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "longenoughpw12", name: "Tester" }),
    }),
  );
  const body = (await res.json()) as { id: string };
  return body.id;
}

test("create token — returns value once with zz_ prefix", async () => {
  const userId = await newUser();
  const req = new Request("http://localhost/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "dbt-prod" }),
  });
  const res = await handleCreateToken(req, userId);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; name: string; value: string };
  expect(body.id).toMatch(/^tok_/);
  expect(body.name).toBe("dbt-prod");
  expect(body.value).toMatch(/^zz_/);
  expect(body.value.length).toBeGreaterThan(40);
});

test("create token — stores hash not value", async () => {
  const userId = await newUser();
  const res = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "leak-test" }),
    }),
    userId,
  );
  const body = (await res.json()) as { id: string; value: string };

  const row = await pgGet<{ token_hash: string }>(
    `SELECT token_hash FROM zugzug_app.api_tokens WHERE id = $1`,
    [body.id],
  );
  expect(row?.token_hash).toBeDefined();
  expect(row?.token_hash).not.toBe(body.value);
  expect(row?.token_hash).toMatch(/^\$argon2/); // argon2id hash format
});

test("list tokens — omits values, includes name + created", async () => {
  const userId = await newUser();
  await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alpha" }),
    }),
    userId,
  );
  await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "beta" }),
    }),
    userId,
  );
  const res = await handleListTokens(userId);
  const body = (await res.json()) as { tokens: Array<{ id: string; name: string; created_at: string }> };
  expect(body.tokens).toHaveLength(2);
  expect(body.tokens.map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
  // No 'value' field on listed tokens
  expect(body.tokens.every((t) => !("value" in t))).toBe(true);
});

test("list tokens — only returns current user's tokens", async () => {
  const userA = await newUser("a@example.com");
  // Add userB to allowlist (since they're not the first user)
  const { pgRun } = await import("../src/pg.ts");
  await pgRun(
    `INSERT INTO zugzug_app.allowed_emails (email, added_by, added_at) VALUES ('b@example.com', 'bootstrap', current_timestamp) ON CONFLICT DO NOTHING`,
  );
  const userB = await newUser("b@example.com");

  await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a-token" }),
    }),
    userA,
  );
  await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "b-token" }),
    }),
    userB,
  );

  const aTokens = (await (await handleListTokens(userA)).json()) as { tokens: Array<{ name: string }> };
  const bTokens = (await (await handleListTokens(userB)).json()) as { tokens: Array<{ name: string }> };
  expect(aTokens.tokens.map((t) => t.name)).toEqual(["a-token"]);
  expect(bTokens.tokens.map((t) => t.name)).toEqual(["b-token"]);
});

test("revoke token — token no longer appears in list", async () => {
  const userId = await newUser();
  const res = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "revoke-me" }),
    }),
    userId,
  );
  const body = (await res.json()) as { id: string };

  await handleRevokeToken(body.id, userId);

  const listed = (await (await handleListTokens(userId)).json()) as { tokens: Array<unknown> };
  expect(listed.tokens).toHaveLength(0);
});

test("bearer auth — valid token returns user", async () => {
  const userId = await newUser("bearer@example.com");
  const res = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bearer-test" }),
    }),
    userId,
  );
  const { value } = (await res.json()) as { value: string };

  const req = new Request("http://localhost/api/anywhere", {
    headers: { Authorization: `Bearer ${value}` },
  });
  const user = await getApiTokenUser(req);
  expect(user?.id).toBe(userId);
  expect(user?.email).toBe("bearer@example.com");
});

test("bearer auth — revoked token returns null", async () => {
  const userId = await newUser();
  const res = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "revoked-bearer" }),
    }),
    userId,
  );
  const { id, value } = (await res.json()) as { id: string; value: string };
  await handleRevokeToken(id, userId);

  const req = new Request("http://localhost/api/anywhere", {
    headers: { Authorization: `Bearer ${value}` },
  });
  expect(await getApiTokenUser(req)).toBeNull();
});

test("bearer auth — missing/invalid prefix returns null", async () => {
  const req1 = new Request("http://localhost/api/anywhere");
  expect(await getApiTokenUser(req1)).toBeNull();

  const req2 = new Request("http://localhost/api/anywhere", {
    headers: { Authorization: "Bearer xx_not_a_zugzug_token" },
  });
  expect(await getApiTokenUser(req2)).toBeNull();

  const req3 = new Request("http://localhost/api/anywhere", {
    headers: { Authorization: "Basic dXNlcjpwYXNz" },
  });
  expect(await getApiTokenUser(req3)).toBeNull();
});

test("bearer auth — updates last_used_at", async () => {
  const userId = await newUser();
  const res = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "last-used-test" }),
    }),
    userId,
  );
  const { id, value } = (await res.json()) as { id: string; value: string };

  const before = await pgGet<{ last_used_at: string | null }>(
    `SELECT last_used_at::text AS last_used_at FROM zugzug_app.api_tokens WHERE id = $1`,
    [id],
  );
  expect(before?.last_used_at).toBeNull();

  await getApiTokenUser(
    new Request("http://localhost/api/anywhere", { headers: { Authorization: `Bearer ${value}` } }),
  );

  // Fire-and-forget update is async; wait a tick.
  await new Promise((r) => setTimeout(r, 50));

  const after = await pgGet<{ last_used_at: string | null }>(
    `SELECT last_used_at::text AS last_used_at FROM zugzug_app.api_tokens WHERE id = $1`,
    [id],
  );
  expect(after?.last_used_at).not.toBeNull();
});
