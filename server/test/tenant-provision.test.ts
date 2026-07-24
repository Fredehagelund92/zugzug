process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgGet, pgAll, pgRun } from "../src/pg.ts";
import { provisionTenant, listTenants } from "../src/tenant.ts";
import { promoteSuperAdmin } from "../src/admin.ts";

const TEST_TENANT_IDS = ["tprov_a", "tprov_b", "tprov_dup"];
const TEST_USER_EMAILS = ["promo@example.com"];

beforeEach(async () => {
  for (const id of TEST_TENANT_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [id]);
  }
  for (const email of TEST_USER_EMAILS) {
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE email = $1`, [email]);
  }
});

afterAll(async () => {
  for (const id of TEST_TENANT_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE tenant_id = $1`, [id]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [id]);
  }
  for (const email of TEST_USER_EMAILS) {
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE email = $1`, [email]);
  }
});

test("provisionTenant creates a tenant row with slug = id", async () => {
  const t = await provisionTenant({ id: "tprov_a", label: "Test A" });
  expect(t.id).toBe("tprov_a");
  expect(t.slug).toBe("tprov_a");
  expect(t.label).toBe("Test A");

  const row = await pgGet<{ id: string; slug: string; label: string }>(
    `SELECT id, slug, label FROM "zugzug_app"."tenant" WHERE id = $1`,
    ["tprov_a"],
  );
  expect(row).toEqual({ id: "tprov_a", slug: "tprov_a", label: "Test A" });
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
  for (const bad of [
    "TPROV",
    "with-dash",
    "with space",
    "1starts-with-digit",
    "way_too_long_for_a_tenant_id_limit",
  ]) {
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

test("promoteSuperAdmin sets users.is_super_admin = true for an existing user", async () => {
  // Provision a fresh user row to mutate. The users table is global, no tenant_id.
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email)
     VALUES ('u_promo_test', 'Promo Test', 'PT', 'promo@example.com')
     ON CONFLICT (id) DO UPDATE SET is_super_admin = false`,
  );

  await promoteSuperAdmin("promo@example.com");

  const row = await pgGet<{ is_super_admin: boolean }>(
    `SELECT is_super_admin FROM "zugzug_app"."users" WHERE email = $1`,
    ["promo@example.com"],
  );
  expect(row?.is_super_admin).toBe(true);
});

test("promoteSuperAdmin rejects when the email does not match any user", async () => {
  let thrown: Error | null = null;
  try {
    await promoteSuperAdmin("noone@example.com");
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown).not.toBeNull();
  expect(thrown!.message.toLowerCase()).toContain("not found");
});
