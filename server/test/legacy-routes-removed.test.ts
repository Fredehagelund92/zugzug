process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";

const U_IDS = ["u_legacy_e2e"];

async function cleanup(): Promise<void> {
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function login(userId: string): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, is_super_admin)
     VALUES ($1, $1, 'XX', $2, false)`,
    [userId, `${userId}@example.com`],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ('default', $1, 'admin', now())
     ON CONFLICT DO NOTHING`,
    [userId],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

test("GET /api/team/members returns 404", async () => {
  const cookie = await login("u_legacy_e2e");
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/team/members", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(404);
});

test("GET /api/team/users returns 404", async () => {
  const cookie = await login("u_legacy_e2e");
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/team/users", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(404);
});
