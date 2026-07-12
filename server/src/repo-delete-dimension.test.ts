process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun, pgGet } from "./pg.ts";
import { addDimension, addCanonicalOne, deleteDimension } from "./repo-canonical.ts";

const T = "test_del_dim";
const U = "u_test_del";
const DIM = "deltest";

// Second tenant for cross-tenant isolation test
const T2 = "test_del_dim2";
const U2 = "u_test_del2";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'DelTest', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Del Tester', 'd@example.test', 'DT', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
  // Second tenant + user for cross-tenant isolation
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'DelTest2', now()) ON CONFLICT DO NOTHING`,
    [T2],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Del Tester 2', 'd2@example.test', 'D2', false)
     ON CONFLICT DO NOTHING`,
    [U2],
  );
});

afterAll(async () => {
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_deltest"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_deltest"`).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE id = $1`, [DIM]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."user_grid_layout" WHERE user_id IN ($1, $2)`, [
    U,
    U2,
  ]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id IN ($1, $2)`, [
    T,
    T2,
  ]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id IN ($1, $2)`, [U, U2]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id IN ($1, $2)`, [T, T2]).catch(() => {});
});

describe("deleteDimension", () => {
  it("returns false for an unknown table", async () => {
    expect(await deleteDimension("no_such_dim", U, T)).toBe(false);
  });

  it("deletes the dimension row, metadata rows, and drops dim_/map_ tables; keeps audit", async () => {
    await addDimension("Deltest", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(DIM, "Alpha", undefined, U, T);
    // Enroll U in tenant T so the layout sweep can target it
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
       VALUES ($1, $2, 'editor', now()) ON CONFLICT DO NOTHING`,
      [T, U],
    );
    // Enroll U2 in tenant T2
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
       VALUES ($1, $2, 'editor', now()) ON CONFLICT DO NOTHING`,
      [T2, U2],
    );
    // Seed layout row for U (tenant A's member)
    await pgRun(
      `INSERT INTO "zugzug_app"."user_grid_layout" (user_id, dim_id, config, updated_at)
       VALUES ($1, $2, '{}', now()) ON CONFLICT DO NOTHING`,
      [U, DIM],
    );
    // Seed layout row for U2 (tenant B's member) — simulates tenant B having a same-named dim layout
    await pgRun(
      `INSERT INTO "zugzug_app"."user_grid_layout" (user_id, dim_id, config, updated_at)
       VALUES ($1, $2, '{"cross":"tenant"}', now()) ON CONFLICT DO NOTHING`,
      [U2, DIM],
    );

    expect(await deleteDimension(DIM, U, T)).toBe(true);

    // Tenant A's member layout row must be gone
    expect(
      await pgGet(
        `SELECT dim_id FROM "zugzug_app"."user_grid_layout" WHERE dim_id = $1 AND user_id = $2`,
        [DIM, U],
      ),
    ).toBeNull();

    // Tenant B's member layout row must SURVIVE
    expect(
      await pgGet(
        `SELECT dim_id FROM "zugzug_app"."user_grid_layout" WHERE dim_id = $1 AND user_id = $2`,
        [DIM, U2],
      ),
    ).not.toBeNull();

    expect(await pgGet(`SELECT id FROM "zugzug_app"."dimension" WHERE id = $1`, [DIM])).toBeNull();
    const dimTable = await pgGet(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'zugzug' AND table_name = 'dim_deltest'`,
    );
    expect(dimTable).toBeNull();

    // Audit row must carry the real tenant_id (T), not 'default'
    const audit = await pgGet<{ action: string; tenant_id: string }>(
      `SELECT action, tenant_id FROM "zugzug_app"."audit_log" WHERE action = 'Deleted table' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit).not.toBeNull();
    expect(audit!.tenant_id).toBe(T);
  });
});
