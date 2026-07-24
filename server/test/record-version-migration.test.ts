process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { pgAll, pgRun, pgGet } from "../src/pg.ts";

beforeAll(async () => {
  // Provision a fake dimension + dim_X table the backfill DO-block can find.
  // dim_table / map_table are stored UNQUOTED — cq() splits on . and quotes each
  // half. A previously-stored quoted form ("zugzug_app"."dim_test_e2") would
  // round-trip as a single broken identifier. ON CONFLICT DO UPDATE self-heals
  // any polluted row from earlier test runs that stored the bad format.
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension"
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES
       ('d_test_e2', 'Test E2', 'zugzug_app.dim_test_e2', 'zugzug_app.map_test_e2',
        'country_id', now(), 'default')
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       label = EXCLUDED.label,
       dim_table = EXCLUDED.dim_table,
       map_table = EXCLUDED.map_table,
       key_col = EXCLUDED.key_col`,
  );
  await pgRun(
    `CREATE TABLE IF NOT EXISTS "zugzug_app"."dim_test_e2" (country_id varchar PRIMARY KEY, label varchar)`,
  );
  await pgRun(`DELETE FROM "zugzug_app"."dim_test_e2"`);
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE dim_id = 'd_test_e2'`);
  await pgRun(
    `INSERT INTO "zugzug_app"."dim_test_e2" (country_id, label)
     VALUES ('dk', 'Denmark'), ('no', 'Norway'), ('se', 'Sweden')`,
  );
});

afterAll(async () => {
  // Clean up so the API and the next test run don't see a phantom dim. The
  // dim_X/map_X tables can stay — they're orphaned but invisible without the
  // registry entry.
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE dim_id = 'd_test_e2'`);
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE id = 'd_test_e2'`);
});

test("record_version table exists and is empty for the test dim before backfill", async () => {
  // (The migration already ran in db:migrate above; for this test we re-run
  //  just the backfill block to simulate "what if a new dim was added later".)
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE dim_id = 'd_test_e2'`);
  const empty = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app"."record_version" WHERE dim_id = 'd_test_e2'`,
  );
  expect(empty?.n).toBe(0);
});

test("backfill seeds version=1 for every existing dim row", async () => {
  // Apply the same DO-block the migration uses (idempotent).
  await pgRun(`
    DO $$
    DECLARE d record; sql_stmt text;
    BEGIN
      FOR d IN SELECT id, dim_table, key_col, tenant_id FROM "zugzug_app"."dimension" WHERE id = 'd_test_e2' LOOP
        sql_stmt := format(
          'INSERT INTO "zugzug_app"."record_version" (dim_id, key, version, updated_at, updated_by, tenant_id)
           SELECT %L, %I, 1, now(), %L, %L FROM %s
           ON CONFLICT (tenant_id, dim_id, key) DO NOTHING',
          d.id, d.key_col, 'u_system', d.tenant_id, d.dim_table
        );
        EXECUTE sql_stmt;
      END LOOP;
    END $$;
  `);
  const rows = await pgAll<{ key: string; version: number }>(
    `SELECT key, version FROM "zugzug_app"."record_version"
     WHERE dim_id = 'd_test_e2' ORDER BY key`,
  );
  expect(rows.map((r) => r.key)).toEqual(["dk", "no", "se"]);
  expect(rows.every((r) => r.version === 1)).toBe(true);
});

test("backfill is idempotent — re-running does not duplicate or bump version", async () => {
  // Manually bump one row's version to prove ON CONFLICT DO NOTHING preserves it.
  await pgRun(
    `UPDATE "zugzug_app"."record_version" SET version = 7
       WHERE dim_id = 'd_test_e2' AND key = 'dk'`,
  );
  // Re-run the same backfill block.
  await pgRun(`
    DO $$
    DECLARE d record; sql_stmt text;
    BEGIN
      FOR d IN SELECT id, dim_table, key_col, tenant_id FROM "zugzug_app"."dimension" WHERE id = 'd_test_e2' LOOP
        sql_stmt := format(
          'INSERT INTO "zugzug_app"."record_version" (dim_id, key, version, updated_at, updated_by, tenant_id)
           SELECT %L, %I, 1, now(), %L, %L FROM %s
           ON CONFLICT (tenant_id, dim_id, key) DO NOTHING',
          d.id, d.key_col, 'u_system', d.tenant_id, d.dim_table
        );
        EXECUTE sql_stmt;
      END LOOP;
    END $$;
  `);
  const dk = await pgGet<{ version: number }>(
    `SELECT version FROM "zugzug_app"."record_version"
     WHERE dim_id = 'd_test_e2' AND key = 'dk'`,
  );
  expect(dk?.version).toBe(7);
});
