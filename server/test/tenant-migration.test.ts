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
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, role)
     VALUES ($1, 'Migration Seed', 'MS', 'viewer')
     ON CONFLICT (id) DO UPDATE SET role = 'viewer'`,
    [SEED_USER_ID],
  );
  await pgRun(
    `DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = 'default' AND user_id = $1`,
    [SEED_USER_ID],
  );
  // Re-run the exact membership backfill from 0011 (idempotent) so the seeded
  // user counts as pre-migration even though migrations already ran.
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     SELECT 'default', id, role, now()
       FROM "zugzug_app"."users"
     ON CONFLICT (tenant_id, user_id) DO NOTHING`,
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
  // Hard assertion: the user seeded in beforeAll (pre-backfill) MUST have a
  // default-tenant seat carrying its users.role. This can't pass vacuously.
  const seeded = await pgGet<{ role: string }>(
    `SELECT role FROM "zugzug_app"."tenant_member"
      WHERE tenant_id = 'default' AND user_id = $1`,
    [SEED_USER_ID],
  );
  expect(seeded).not.toBeNull();
  expect(seeded!.role).toBe("viewer");

  // And every membership the backfill created is role-consistent with users.
  const mismatched = await pgAll<{ user_id: string }>(
    `SELECT m.user_id
       FROM "zugzug_app"."tenant_member" m
       JOIN "zugzug_app"."users" u ON u.id = m.user_id
      WHERE m.tenant_id = 'default' AND m.role <> u.role`,
  );
  expect(mismatched).toEqual([]);
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
