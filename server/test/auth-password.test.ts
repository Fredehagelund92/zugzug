process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
delete process.env.OIDC_ISSUER_URL; // password mode
process.env.ALLOWED_DOMAIN = ""; // no domain restriction by default

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { handleSignup, handleLogin, handleChangePassword } from "../src/auth-password.ts";
import { pgGet, pgRun } from "../src/pg.ts";
import { pg } from "../src/env.ts";

beforeEach(async () => {
  await resetDb();
});

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/auth/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("signup — first user becomes admin", async () => {
  const res = await handleSignup(
    jsonReq({ email: "first@example.com", password: "longenoughpw12", name: "Ada Lovelace" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string; name: string; email: string };
  expect(body.email).toBe("first@example.com");
  expect(body.name).toBe("Ada Lovelace");
  expect(res.headers.get("set-cookie")).toContain("zz_sid=");
});

test("signup — rejects weak password", async () => {
  const res = await handleSignup(
    jsonReq({ email: "weak@example.com", password: "short", name: "Test" }),
  );
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; minLength: number };
  expect(body.error).toBe("password_too_short");
  expect(body.minLength).toBe(12);
});

test("signup — second user requires allowlist", async () => {
  // First user
  await handleSignup(
    jsonReq({ email: "admin@example.com", password: "longenoughpw12", name: "Admin" }),
  );
  // Second user not on allowlist
  const res = await handleSignup(
    jsonReq({ email: "rando@example.com", password: "longenoughpw12", name: "Rando" }),
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not_allowed");
});

test("signup — email already in use returns 409", async () => {
  await handleSignup(
    jsonReq({ email: "dup@example.com", password: "longenoughpw12", name: "First" }),
  );
  const res = await handleSignup(
    jsonReq({ email: "dup@example.com", password: "longenoughpw13", name: "Second" }),
  );
  expect(res.status).toBe(409);
});

test("login — valid credentials return session cookie", async () => {
  await handleSignup(
    jsonReq({ email: "test@example.com", password: "longenoughpw12", name: "Test" }),
  );
  const res = await handleLogin(jsonReq({ email: "test@example.com", password: "longenoughpw12" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("zz_sid=");
});

test("login — wrong password returns generic 401", async () => {
  await handleSignup(
    jsonReq({ email: "test@example.com", password: "longenoughpw12", name: "Test" }),
  );
  const res = await handleLogin(
    jsonReq({ email: "test@example.com", password: "wrong_password_12" }),
  );
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("invalid_credentials");
});

test("login — unknown email returns same generic 401 (no enumeration)", async () => {
  const res = await handleLogin(
    jsonReq({ email: "ghost@example.com", password: "longenoughpw12" }),
  );
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("invalid_credentials");
});

test("change-password — success path", async () => {
  // Set up a user
  const signup = await handleSignup(
    jsonReq({ email: "cp@example.com", password: "originalpw1234", name: "Test" }),
  );
  const userId = ((await signup.clone().json()) as { id: string }).id;

  const res = await handleChangePassword(
    jsonReq({ currentPassword: "originalpw1234", newPassword: "newpassword1234" }),
    userId,
  );
  expect(res.status).toBe(204);

  // Login with new password works
  const login = await handleLogin(
    jsonReq({ email: "cp@example.com", password: "newpassword1234" }),
  );
  expect(login.status).toBe(200);
});

test("change-password — wrong current returns 401", async () => {
  const signup = await handleSignup(
    jsonReq({ email: "cp@example.com", password: "originalpw1234", name: "Test" }),
  );
  const userId = ((await signup.clone().json()) as { id: string }).id;

  const res = await handleChangePassword(
    jsonReq({ currentPassword: "wrong", newPassword: "newpassword1234" }),
    userId,
  );
  expect(res.status).toBe(401);
});

test("change-password — short new password returns 400", async () => {
  const signup = await handleSignup(
    jsonReq({ email: "cp@example.com", password: "originalpw1234", name: "Test" }),
  );
  const userId = ((await signup.clone().json()) as { id: string }).id;

  const res = await handleChangePassword(
    jsonReq({ currentPassword: "originalpw1234", newPassword: "short" }),
    userId,
  );
  expect(res.status).toBe(400);
});

test("signup — first user gets role='admin'", async () => {
  const res = await handleSignup(
    jsonReq({ email: "first@example.com", password: "longenoughpw12", name: "Admin" }),
  );
  expect(res.status).toBe(200);
  const userId = ((await res.json()) as { id: string }).id;
  const row = await pgGet<{ role: string }>(
    `SELECT role FROM ${pg("tenant_member")} WHERE user_id = $1 AND tenant_id = 'default'`,
    [userId],
  );
  expect(row?.role).toBe("admin");
});

test("signup — second user gets role='editor'", async () => {
  // First signup (becomes admin + gets default tenant membership)
  await handleSignup(
    jsonReq({ email: "admin@example.com", password: "longenoughpw12", name: "Admin" }),
  );
  // Invite second user via tenant_invite so they pass the gate.
  // Use 'bootstrap' as invited_by — robust to parallel-test environments.
  await pgRun(
    `INSERT INTO ${pg("tenant_invite")} (tenant_id, email, role, invited_by, invited_at)
     VALUES ('default', 'second@example.com', 'editor', 'bootstrap', now())
     ON CONFLICT DO NOTHING`,
  );
  const res = await handleSignup(
    jsonReq({ email: "second@example.com", password: "longenoughpw12", name: "Second" }),
  );
  expect(res.status).toBe(200);
  const userId = ((await res.json()) as { id: string }).id;
  const row = await pgGet<{ role: string }>(
    `SELECT role FROM ${pg("tenant_member")} WHERE user_id = $1 AND tenant_id = 'default'`,
    [userId],
  );
  expect(row?.role).toBe("editor");
});
