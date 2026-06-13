process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { TenantRepo } from "../src/tenant-repo.ts";

const T_IDS = ["taudit_a", "taudit_b"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

test("tenant A's audit list does not include tenant B's entries", async () => {
  await provisionTenant({ id: "taudit_a", label: "A" });
  await provisionTenant({ id: "taudit_b", label: "B" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email)
     VALUES ('u_audit', 'U', 'XX', 'u_audit@x')
     ON CONFLICT (id) DO NOTHING`,
  );

  const a = new TenantRepo("taudit_a", "editor");
  const b = new TenantRepo("taudit_b", "editor");
  await a.appendAudit("u_audit", "edit", "detail-A");
  await b.appendAudit("u_audit", "edit", "detail-B");

  const aList = await a.listAudit();
  const bList = await b.listAudit();

  expect(aList.map((r) => r.detail)).toContain("detail-A");
  expect(aList.map((r) => r.detail)).not.toContain("detail-B");
  expect(bList.map((r) => r.detail)).toContain("detail-B");
  expect(bList.map((r) => r.detail)).not.toContain("detail-A");
});

test("super-admin '*' tenant sees both tenants' entries", async () => {
  await provisionTenant({ id: "taudit_a", label: "A" });
  await provisionTenant({ id: "taudit_b", label: "B" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email)
     VALUES ('u_audit', 'U', 'XX', 'u_audit@x')
     ON CONFLICT (id) DO NOTHING`,
  );

  const a = new TenantRepo("taudit_a", "editor");
  const b = new TenantRepo("taudit_b", "editor");
  await a.appendAudit("u_audit", "edit", "detail-A-sa");
  await b.appendAudit("u_audit", "edit", "detail-B-sa");

  const sa = new TenantRepo("*", "admin", true);
  const all = await sa.listAudit(200);
  const details = all.map((r) => r.detail);
  expect(details).toContain("detail-A-sa");
  expect(details).toContain("detail-B-sa");
});

test("appendAudit as viewer → 403", async () => {
  await provisionTenant({ id: "taudit_a", label: "A" });
  const viewer = new TenantRepo("taudit_a", "viewer");
  let thrown = false;
  try {
    await viewer.appendAudit("u_audit", "edit", "nope");
  } catch {
    thrown = true;
  }
  expect(thrown).toBe(true);
});
