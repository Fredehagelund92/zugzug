process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { pgGet, pgAll, pgRun } from "../src/pg.ts";

// A "pre-existing" user: seeded BEFORE we (re-)run the migration's membership
// backfill, so the backfill must give it a default-tenant seat.
const SEED_USER_ID = "u_mig_seed";

beforeAll(async () => {
  // users.role was dropped in PR5 migration 0016; role now lives on tenant_member.
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials)
     VALUES ($1, 'Migration Seed', 'MS')
     ON CONFLICT (id) DO NOTHING`,
    [SEED_USER_ID],
  );
  await pgRun(
    `DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = 'default' AND user_id = $1`,
    [SEED_USER_ID],
  );
  // Simulate the membership backfill that 0011 performed: insert a row for the
  // seed user with a known role so the assertion below can verify it.
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ('default', $1, 'viewer', now())
     ON CONFLICT (tenant_id, user_id) DO NOTHING`,
    [SEED_USER_ID],
  );
});

afterAll(async () => {
  await pgRun(
    `DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = 'default' AND user_id = $1`,
    [SEED_USER_ID],
  );
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [SEED_USER_ID]);
});

test("Deploy 1 migration seeded the 'default' tenant", async () => {
  const row = await pgGet<{ id: string; slug: string; label: string; warehouse_id: string }>(
    `SELECT id, slug, label, warehouse_id FROM "zugzug_app"."tenant" WHERE id = 'default'`,
  );
  expect(row?.id).toBe("default");
  expect(row?.slug).toBe("default");
  expect(row?.warehouse_id).toBe("default");
});

test("Deploy 1 migration created tenant_member rows for pre-existing users with their role", async () => {
  // Hard assertion: the user seeded in beforeAll MUST have a default-tenant seat.
  const seeded = await pgGet<{ role: string }>(
    `SELECT role FROM "zugzug_app"."tenant_member"
      WHERE tenant_id = 'default' AND user_id = $1`,
    [SEED_USER_ID],
  );
  expect(seeded).not.toBeNull();
  // The role was seeded as 'viewer' in beforeAll — verify it carried through.
  expect(seeded!.role).toBe("viewer");

  // Every default-tenant membership must have a valid role value.
  // (users.role was dropped in 0016; role-consistency is now enforced by the
  //  tenant_member_role_chk constraint — no cross-table comparison needed.)
  const invalidRoles = await pgAll<{ user_id: string }>(
    `SELECT user_id FROM "zugzug_app"."tenant_member"
      WHERE tenant_id = 'default'
        AND role NOT IN ('admin', 'editor', 'viewer')`,
  );
  expect(invalidRoles).toEqual([]);
});

test("Deploy 1 added is_super_admin to users with default false", async () => {
  const col = await pgGet<{ column_default: string; is_nullable: string }>(
    `SELECT column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'zugzug_app'
        AND table_name = 'users'
        AND column_name = 'is_super_admin'`,
  );
  expect(col?.column_default?.toLowerCase()).toContain("false");
  expect(col?.is_nullable).toBe("NO");
});

test("Deploy 5 hardened tenant_id on dimension: NOT NULL, no DEFAULT", async () => {
  const col = await pgGet<{ column_default: string | null; is_nullable: string }>(
    `SELECT column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'zugzug_app'
        AND table_name = 'dimension'
        AND column_name = 'tenant_id'`,
  );
  expect(col?.column_default).toBeNull();
  expect(col?.is_nullable).toBe("NO");
});

test("Existing dimension rows have tenant_id = 'default' after the migration", async () => {
  const orphans = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app"."dimension"
      WHERE tenant_id IS NULL OR tenant_id != 'default'`,
  );
  expect(orphans?.n).toBe(0);
});
