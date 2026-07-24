process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import "./setup.ts";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun, pgGet, pgAll } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import * as record from "../src/repo-record.ts";
import { appendAuditAs } from "../src/repo-meta.ts";

const T = "ttear_a";
const D = "ttear_thing";
const RECORD_SCHEMA = process.env.ZUGZUG_DB?.trim() || "zugzug";
const U_IDS = ["u_tear_super"];

async function cleanup(): Promise<void> {
  await pgRun(`DROP TABLE IF EXISTS "${RECORD_SCHEMA}"."dim_${D}"`);
  await pgRun(`DROP TABLE IF EXISTS "${RECORD_SCHEMA}"."map_${D}"`);
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_field" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
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

test("POST /api/admin/tenants/:id/teardown drops dynamic tables + wipes scoped rows", async () => {
  await provisionTenant({ id: T, label: "Tear" });
  await record.addRefTable(D, [], { keyKind: "slug" }, "u_tear_super", T);
  await appendAuditAs("u_tear_super", "test_action", "detail", { tenantId: T });

  // Pre-condition: dim_/map_ exist and refTable/audit rows are populated.
  const before = await pgAll<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name IN ($2, $3)`,
    [RECORD_SCHEMA, `dim_${D}`, `map_${D}`],
  );
  expect(before.length).toBe(2);

  const cookie = await login("u_tear_super", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/admin/tenants/${T}/teardown`, {
      method: "POST",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(200);

  // Post-condition: dim_/map_ dropped, scoped rows gone, tenant soft-deleted.
  const after = await pgAll<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name IN ($2, $3)`,
    [RECORD_SCHEMA, `dim_${D}`, `map_${D}`],
  );
  expect(after.length).toBe(0);

  const refTables = await pgAll(
    `SELECT id FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`,
    [T],
  );
  expect(refTables.length).toBe(0);

  const audit = await pgAll(`SELECT id FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]);
  expect(audit.length).toBe(0);

  const tenant = await pgGet<{ deleted_at: Date | null }>(
    `SELECT deleted_at FROM "zugzug_app"."tenant" WHERE id = $1`,
    [T],
  );
  expect(tenant?.deleted_at).not.toBeNull();
});

test("POST /api/admin/tenants/default/teardown → 400", async () => {
  const cookie = await login("u_tear_super", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/tenants/default/teardown", {
      method: "POST",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(400);
});

test("POST /api/admin/tenants/:id/teardown as non-super-admin → 403", async () => {
  await provisionTenant({ id: T, label: "Tear" });
  const cookie = await login("u_tear_super", false);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/admin/tenants/${T}/teardown`, {
      method: "POST",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(403);
});
