process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";

const T_IDS = ["t_label_e2e"];
const U_IDS = ["u_label_admin_e2e", "u_label_editor_e2e"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function login(
  userId: string,
  role: "admin" | "editor",
  tenantId: string,
): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, is_super_admin)
     VALUES ($1, $1, 'XX', $2, false)`,
    [userId, `${userId}@example.com`],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at) VALUES ($1, $2, $3, now())`,
    [tenantId, userId, role],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

test("PATCH /api/t/t-label-e2e with admin cookie → 204 + label updated", async () => {
  await provisionTenant({ id: "t_label_e2e", label: "Original Label" });
  const cookie = await login("u_label_admin_e2e", "admin", "t_label_e2e");
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/t/t_label_e2e", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "New Label" }),
    }),
    () => {},
  );
  expect(res.status).toBe(204);

  // Verify DB was updated
  const { pgGet } = await import("../src/pg.ts");
  const row = await pgGet<{ label: string }>(
    `SELECT label FROM "zugzug_app"."tenant" WHERE id = $1`,
    ["t_label_e2e"],
  );
  expect(row?.label).toBe("New Label");
});

test("PATCH /api/t/t-label-e2e with editor cookie → 403", async () => {
  await provisionTenant({ id: "t_label_e2e", label: "Original Label" });
  const cookie = await login("u_label_editor_e2e", "editor", "t_label_e2e");
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/t/t_label_e2e", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "Hacked Label" }),
    }),
    () => {},
  );
  expect(res.status).toBe(403);
});
