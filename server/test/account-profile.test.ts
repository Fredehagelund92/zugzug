process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun, pgGet } from "../src/pg.ts";

const U_IDS = ["u_profile_e2e"];

async function cleanup(): Promise<void> {
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function login(userId: string): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, is_super_admin)
     VALUES ($1, 'Original Name', 'ON', $2, false)`,
    [userId, `${userId}@example.com`],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

test("PATCH /api/auth/me updates name", async () => {
  const cookie = await login("u_profile_e2e");
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/auth/me", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    }),
    () => {},
  );
  expect(res.status).toBe(204);
  const row = await pgGet<{ name: string }>(
    `SELECT name FROM "zugzug_app"."users" WHERE id = $1`,
    ["u_profile_e2e"],
  );
  expect(row?.name).toBe("New Name");
});

test("PATCH /api/auth/me rejects empty name", async () => {
  const cookie = await login("u_profile_e2e");
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/auth/me", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    }),
    () => {},
  );
  expect(res.status).toBe(400);
});

test("PATCH /api/auth/me returns 401 when not signed in", async () => {
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Hacker" }),
    }),
    () => {},
  );
  expect(res.status).toBe(401);
});
