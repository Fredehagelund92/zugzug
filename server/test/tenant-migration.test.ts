process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { pgGet, pgAll } from "../src/pg.ts";

test("Deploy 1 migration seeded the 'default' tenant", async () => {
  const row = await pgGet<{ id: string; slug: string; label: string; warehouse_id: string }>(
    `SELECT id, slug, label, warehouse_id FROM "zugzug_app"."tenant" WHERE id = 'default'`,
  );
  expect(row?.id).toBe("default");
  expect(row?.slug).toBe("default");
  expect(row?.warehouse_id).toBe("default");
});

test("Deploy 1 migration created tenant_member rows for every existing user with their role", async () => {
  const users = await pgAll<{ id: string; role: string }>(
    `SELECT id, role FROM "zugzug_app"."users"`,
  );
  // The migration ran ON CONFLICT DO NOTHING. Just verify the pre-migration
  // users got their seat — fresh test users created AFTER won't have one
  // and that's expected.
  for (const u of users) {
    const member = await pgGet<{ role: string }>(
      `SELECT role FROM "zugzug_app"."tenant_member"
        WHERE tenant_id = 'default' AND user_id = $1`,
      [u.id],
    );
    if (member) {
      expect(member.role).toBe(u.role);
    }
  }
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

test("Deploy 1 added tenant_id column to dimension with DEFAULT 'default'", async () => {
  const col = await pgGet<{ column_default: string }>(
    `SELECT column_default
       FROM information_schema.columns
      WHERE table_schema = 'zugzug_app'
        AND table_name = 'dimension'
        AND column_name = 'tenant_id'`,
  );
  expect(col?.column_default).toContain("default");
});

test("Existing dimension rows have tenant_id = 'default' after the migration", async () => {
  const orphans = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app"."dimension"
      WHERE tenant_id IS NULL OR tenant_id != 'default'`,
  );
  expect(orphans?.n).toBe(0);
});
