process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun, pgGet } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";

const T_IDS = ["timp_target"];
const U_IDS = ["u_imp_super"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."active_sessions" WHERE user_id = $1`, [u]);
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

test("POST /api/admin/impersonate/:tenant_id sets the flag and writes audit", async () => {
  await provisionTenant({ id: "timp_target", label: "Target" });
  const cookie = await login("u_imp_super", true);
  const { handle } = await import("../src/server.ts");

  const res = await handle(
    new Request("http://localhost/api/admin/impersonate/timp_target", {
      method: "POST",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { impersonating: string | null };
  expect(body.impersonating).toBe("timp_target");

  const row = await pgGet<{ impersonating_tenant_id: string | null }>(
    `SELECT impersonating_tenant_id FROM "zugzug_app"."active_sessions" WHERE user_id = $1`,
    ["u_imp_super"],
  );
  expect(row?.impersonating_tenant_id).toBe("timp_target");

  const audit = await pgGet<{ action: string }>(
    `SELECT action FROM "zugzug_app"."audit_log"
      WHERE tenant_id = 'timp_target' AND action = 'impersonate_start'
      LIMIT 1`,
  );
  expect(audit?.action).toBe("impersonate_start");
});

test("POST /api/admin/impersonate (no target) clears the flag", async () => {
  await provisionTenant({ id: "timp_target", label: "Target" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin)
     VALUES ('u_imp_super', 'super', 'XX', 'u_imp_super@example.com', 'editor', true)`,
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."active_sessions" (user_id, last_seen, impersonating_tenant_id)
     VALUES ('u_imp_super', current_timestamp, 'timp_target')`,
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession("u_imp_super");
  const cookie = `zz_sid=${sessionId}`;

  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/impersonate", {
      method: "POST",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { impersonating: string | null };
  expect(body.impersonating).toBeNull();

  const row = await pgGet<{ impersonating_tenant_id: string | null }>(
    `SELECT impersonating_tenant_id FROM "zugzug_app"."active_sessions" WHERE user_id = $1`,
    ["u_imp_super"],
  );
  expect(row?.impersonating_tenant_id).toBeNull();
});

test("POST /api/admin/impersonate/:unknown → 404", async () => {
  const cookie = await login("u_imp_super", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/impersonate/no_such_slug", {
      method: "POST",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(404);
});
