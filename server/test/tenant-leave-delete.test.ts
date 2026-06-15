process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun, pgGet } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";

const T_IDS = ["t_leave_e2e", "t_delete_e2e"];
const U_IDS = [
  "u_leave_admin_e2e",
  "u_leave_editor_e2e",
  "u_delete_admin_e2e",
  "u_leave_admin2_e2e",
];

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
     VALUES ($1, $1, 'XX', $2, false)
     ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@example.com`],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [tenantId, userId, role],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

test("POST /api/t/:slug/leave removes membership → 204 + member row gone", async () => {
  await provisionTenant({ id: "t_leave_e2e", label: "Leave Test" });
  // Two admins so the leaving admin doesn't trigger last-admin guard
  const adminCookie = await login("u_leave_admin_e2e", "admin", "t_leave_e2e");
  await login("u_leave_admin2_e2e", "admin", "t_leave_e2e");

  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/t/t_leave_e2e/leave", {
      method: "POST",
      headers: { cookie: adminCookie },
    }),
    () => {},
  );
  expect(res.status).toBe(204);

  const row = await pgGet<{ user_id: string }>(
    `SELECT user_id FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1 AND user_id = $2`,
    ["t_leave_e2e", "u_leave_admin_e2e"],
  );
  expect(row).toBeNull();
});

test("POST /api/t/:slug/leave when last admin → 409 with error: last_admin", async () => {
  await provisionTenant({ id: "t_leave_e2e", label: "Leave Test" });
  // Only one admin — last-admin guard should fire
  const adminCookie = await login("u_leave_admin_e2e", "admin", "t_leave_e2e");

  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/t/t_leave_e2e/leave", {
      method: "POST",
      headers: { cookie: adminCookie },
    }),
    () => {},
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("last_admin");
});

test("DELETE /api/t/:slug deletes workspace → 204 + tenant row gone", async () => {
  await provisionTenant({ id: "t_delete_e2e", label: "Delete Test" });
  const adminCookie = await login("u_delete_admin_e2e", "admin", "t_delete_e2e");

  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/t/t_delete_e2e", {
      method: "DELETE",
      headers: { cookie: adminCookie },
    }),
    () => {},
  );
  expect(res.status).toBe(204);

  // tenant should be soft-deleted (deleted_at set)
  const row = await pgGet<{ deleted_at: Date | null }>(
    `SELECT deleted_at FROM "zugzug_app"."tenant" WHERE id = $1`,
    ["t_delete_e2e"],
  );
  expect(row?.deleted_at).not.toBeNull();
});

test("DELETE /api/t/default → 403 or 409 (refuses to delete default tenant)", async () => {
  // Default tenant exists by seed; a non-member user won't even reach the route
  // so we expect 401/403; if they were a member the default guard returns 409.
  // Either way the default tenant must not be deleted.
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/t/default", {
      method: "DELETE",
    }),
    () => {},
  );
  // Unauthenticated → 401 or 403; either is acceptable
  expect([401, 403, 409]).toContain(res.status);

  // Tenant still exists
  const row = await pgGet<{ deleted_at: Date | null }>(
    `SELECT deleted_at FROM "zugzug_app"."tenant" WHERE id = $1`,
    ["default"],
  );
  expect(row?.deleted_at).toBeNull();
});
