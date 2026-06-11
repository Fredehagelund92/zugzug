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
import { appendAuditAs } from "../src/repo-meta.ts";

const T_IDS = ["taud_a", "taud_b"];
const U_IDS = ["u_aud_super"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function login(userId: string, isSuperAdmin: boolean): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin)
     VALUES ($1, $1, 'XX', $2, 'editor', $3)`,
    [userId, `${userId}@example.com`, isSuperAdmin],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

test("GET /api/admin/audit returns cross-tenant entries by default", async () => {
  await provisionTenant({ id: "taud_a", label: "A" });
  await provisionTenant({ id: "taud_b", label: "B" });
  await appendAuditAs("u_aud_super", "test_action_a", "from A", { tenantId: "taud_a" });
  await appendAuditAs("u_aud_super", "test_action_b", "from B", { tenantId: "taud_b" });

  const cookie = await login("u_aud_super", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/audit?limit=50", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(200);
  const entries = (await res.json()) as Array<{ action: string; detail: string }>;
  const actions = entries.map((e) => e.action);
  expect(actions).toContain("test_action_a");
  expect(actions).toContain("test_action_b");
});

test("GET /api/admin/audit?tenant_id=… filters to that tenant", async () => {
  await provisionTenant({ id: "taud_a", label: "A" });
  await provisionTenant({ id: "taud_b", label: "B" });
  await appendAuditAs("u_aud_super", "test_action_a", "from A", { tenantId: "taud_a" });
  await appendAuditAs("u_aud_super", "test_action_b", "from B", { tenantId: "taud_b" });

  const cookie = await login("u_aud_super", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/audit?tenant_id=taud_a&limit=50", {
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(200);
  const entries = (await res.json()) as Array<{ action: string }>;
  const actions = entries.map((e) => e.action);
  expect(actions).toContain("test_action_a");
  expect(actions).not.toContain("test_action_b");
});

test("GET /api/admin/audit as non-super-admin → 403", async () => {
  const cookie = await login("u_aud_super", false);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/audit", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(403);
});
