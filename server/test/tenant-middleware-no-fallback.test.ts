process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";

const U_IDS = ["u_nomember_e2e"];

async function cleanup(): Promise<void> {
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

test("user with no tenant_member rows + not super-admin → 403 no_membership on legacy /api/preferences", async () => {
  // Insert user WITHOUT a tenant_member row.
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, is_super_admin)
     VALUES ($1, $1, 'XX', $2, false)`,
    ["u_nomember_e2e", "u_nomember_e2e@example.com"],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession("u_nomember_e2e");
  const cookie = `zz_sid=${sessionId}`;

  const { handle } = await import("../src/server.ts");
  // Hit a legacy un-tenanted route — no slug, so tenant-middleware should reject.
  const res = await handle(
    new Request("http://localhost/api/preferences", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBe("no_membership");
});
