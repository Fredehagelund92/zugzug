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
});

afterAll(async () => {
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_deltest"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_deltest"`).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE id = $1`, [DIM]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("deleteDimension", () => {
  it("returns false for an unknown table", async () => {
    expect(await deleteDimension("no_such_dim", U)).toBe(false);
  });

  it("deletes the dimension row, metadata rows, and drops dim_/map_ tables; keeps audit", async () => {
    await addDimension("Deltest", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(DIM, "Alpha", undefined, U, T);
    // seed one metadata row that has no FK cascade, to prove the sweep:
    await pgRun(
      `INSERT INTO "zugzug_app"."user_grid_layout" (user_id, dim_id, config, updated_at)
       VALUES ($1, $2, '{}', now()) ON CONFLICT DO NOTHING`,
      [U, DIM],
    );

    expect(await deleteDimension(DIM, U)).toBe(true);

    expect(await pgGet(`SELECT id FROM "zugzug_app"."dimension" WHERE id = $1`, [DIM])).toBeNull();
    expect(
      await pgGet(`SELECT dim_id FROM "zugzug_app"."user_grid_layout" WHERE dim_id = $1`, [DIM]),
    ).toBeNull();
    const dimTable = await pgGet(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'zugzug' AND table_name = 'dim_deltest'`,
    );
    expect(dimTable).toBeNull();
    const audit = await pgGet(
      `SELECT action FROM "zugzug_app"."audit_log" WHERE action = 'Deleted table' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit).not.toBeNull();
  });
});
