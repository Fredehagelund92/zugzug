process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgGet, pgAll, pgRun } from "../src/pg.ts";
import { provisionTenant, listTenants } from "../src/tenant.ts";

const TEST_TENANT_IDS = ["tprov_a", "tprov_b", "tprov_dup"];

beforeEach(async () => {
  for (const id of TEST_TENANT_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [id]);
  }
});

afterAll(async () => {
  for (const id of TEST_TENANT_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [id]);
  }
});

test("provisionTenant creates a tenant row with slug = id and pointing at default warehouse", async () => {
  const t = await provisionTenant({ id: "tprov_a", label: "Test A" });
  expect(t.id).toBe("tprov_a");
  expect(t.slug).toBe("tprov_a");
  expect(t.label).toBe("Test A");
  expect(t.warehouse_id).toBe("default");

  const row = await pgGet<{ id: string; slug: string; label: string; warehouse_id: string }>(
    `SELECT id, slug, label, warehouse_id FROM "zugzug_app"."tenant" WHERE id = $1`,
    ["tprov_a"],
  );
  expect(row).toEqual({ id: "tprov_a", slug: "tprov_a", label: "Test A", warehouse_id: "default" });
});

test("provisionTenant with a duplicate id rejects with a clear error", async () => {
  await provisionTenant({ id: "tprov_dup", label: "First" });
  let thrown: Error | null = null;
  try {
    await provisionTenant({ id: "tprov_dup", label: "Second" });
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown).not.toBeNull();
  expect(thrown!.message.toLowerCase()).toContain("already exists");
});

test("provisionTenant rejects invalid id formats", async () => {
  for (const bad of ["TPROV", "with-dash", "with space", "1starts-with-digit", "way_too_long_for_a_tenant_id_limit"]) {
    let thrown: Error | null = null;
    try {
      await provisionTenant({ id: bad, label: "x" });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
  }
});

test("listTenants returns the default tenant plus any provisioned ones", async () => {
  await provisionTenant({ id: "tprov_a", label: "Test A" });
  await provisionTenant({ id: "tprov_b", label: "Test B" });

  const all = await listTenants();
  const ids = all.map((t) => t.id);
  expect(ids).toContain("default");
  expect(ids).toContain("tprov_a");
  expect(ids).toContain("tprov_b");
});
