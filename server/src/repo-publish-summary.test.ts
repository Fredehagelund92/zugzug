process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.ZUGZUG_CURSOR_KEY =
  process.env.ZUGZUG_CURSOR_KEY || "lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8=";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet } from "./pg.ts";
import { addRefTable } from "./repo-record.ts";
import { publishSummaryFor } from "./repo-drafts.ts";

const T = "test_publish_summary";
const U = "u_test_publish_summary";
const createdDims: string[] = [];

// Seed a record record + its record_version row (never-published refTable).
async function seedRecord(refTableId: string, key: string, label: string): Promise<void> {
  const meta = await pgGet<{ dim_table: string; key_col: string }>(
    `SELECT dim_table, key_col FROM "zugzug_app"."reference_table" WHERE id = $1 AND tenant_id = $2`,
    [refTableId, T],
  );
  if (!meta) throw new Error(`seedRecord: refTable ${refTableId} not found`);
  const [schema, table] = meta.dim_table.split(".");
  await pgRun(
    `INSERT INTO "${schema}"."${table}" ("${meta.key_col}", label) VALUES ($1, $2)
     ON CONFLICT ("${meta.key_col}") DO NOTHING`,
    [key, label],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."record_version" (reference_table_id, key, version, updated_at, updated_by, tenant_id)
     VALUES ($1, $2, 1, now(), $3, $4)
     ON CONFLICT (tenant_id, reference_table_id, key) DO NOTHING`,
    [refTableId, key, U, T],
  );
}

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'PubSum', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'PubSum Test', 'ps@example.test', 'PS', false) ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  for (const id of createdDims) {
    await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${id}"`).catch(() => {});
    await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${id}"`).catch(() => {});
  }
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("publishSummaryFor", () => {
  it("never-published refTable: version 0, changedRecords = every record", async () => {
    const refTableId = await addRefTable("PubSumCountry", [], { silent: true }, U, T);
    createdDims.push(refTableId);
    await seedRecord(refTableId, "DE", "Germany");
    await seedRecord(refTableId, "FR", "France");

    const summary = await publishSummaryFor(refTableId, T);

    expect(summary.version).toBe(0);
    expect(summary.publishedAt).toBeNull();
    expect(summary.pendingDrafts).toBe(0);
    expect(summary.changedRecords).toBe(2);
  });
});
