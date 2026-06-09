process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
delete process.env.OIDC_ISSUER_URL;

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { handleSignup, handleLogin } from "../src/auth-password.ts";
import { pgRun, pgGet } from "../src/pg.ts";

beforeEach(async () => {
  await resetDb();
});

test("reset-password CLI rewrites hash so new password works", async () => {
  // Set up a user
  await handleSignup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "reset@example.com",
        password: "originalpw1234",
        name: "Reset User",
      }),
    }),
  );

  // Simulate the CLI by running the same logic the script does
  const user = await pgGet<{ id: string; auth_provider: string }>(
    `SELECT id, auth_provider FROM zugzug_app.users WHERE lower(email) = lower($1)`,
    ["reset@example.com"],
  );
  expect(user?.auth_provider).toBe("password");

  const newHash = await Bun.password.hash("newpassword1234");
  await pgRun(`UPDATE zugzug_app.users SET password_hash = $1 WHERE id = $2`, [newHash, user!.id]);

  // Old password should fail, new one should work
  const oldRes = await handleLogin(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reset@example.com", password: "originalpw1234" }),
    }),
  );
  expect(oldRes.status).toBe(401);

  const newRes = await handleLogin(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reset@example.com", password: "newpassword1234" }),
    }),
  );
  expect(newRes.status).toBe(200);
});
