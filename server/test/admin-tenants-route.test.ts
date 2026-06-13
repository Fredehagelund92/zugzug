process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";

const T_IDS = ["tadmin_e2e"];
const U_IDS = ["u_admin_e2e", "u_nonadmin_e2e"];

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

async function login(userId: string, isSuperAdmin: boolean): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, is_super_admin)
     VALUES ($1, $1, 'XX', $2, $3)`,
    [userId, `${userId}@example.com`, isSuperAdmin],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

test("GET /api/admin/tenants as super-admin → 200 + list including default", async () => {
  const cookie = await login("u_admin_e2e", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/tenants", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tenants: { id: string }[] };
  expect(body.tenants.map((t) => t.id)).toContain("default");
});

test("GET /api/admin/tenants as non-super-admin → 403", async () => {
  const cookie = await login("u_nonadmin_e2e", false);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/tenants", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(403);
});

test("POST /api/admin/tenants as super-admin provisions a new tenant", async () => {
  const cookie = await login("u_admin_e2e", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/tenants", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "tadmin_e2e", label: "E2E Test" }),
    }),
    () => {},
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; label: string };
  expect(body.id).toBe("tadmin_e2e");
  expect(body.label).toBe("E2E Test");
});

test("POST /api/admin/tenants with duplicate id → 409", async () => {
  const cookie = await login("u_admin_e2e", true);
  const { handle } = await import("../src/server.ts");
  await handle(
    new Request("http://localhost/api/admin/tenants", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "tadmin_e2e", label: "First" }),
    }),
    () => {},
  );
  const res = await handle(
    new Request("http://localhost/api/admin/tenants", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "tadmin_e2e", label: "Second" }),
    }),
    () => {},
  );
  expect(res.status).toBe(409);
});
