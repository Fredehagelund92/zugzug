// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet } from "../src/pg.ts";
import { addRecordOne, renameRecord, retireRecord, mergeRecord } from "../src/repo-record.ts";
import { AppError } from "../src/errors.ts";

const REF_TABLE = "d_canon_test";
const T = "default";
// Store unquoted identifiers — cq() will add quotes when building SQL
const DIM_TABLE = "zugzug_app.dim_d_canon_test";
const MAP_TABLE = "zugzug_app.map_d_canon_test";
const KEY_COL = "country_id";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."reference_table"
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (tenant_id, id) DO UPDATE SET label = EXCLUDED.label, dim_table = EXCLUDED.dim_table, map_table = EXCLUDED.map_table, key_col = EXCLUDED.key_col`,
    [REF_TABLE, "Canon Test", DIM_TABLE, MAP_TABLE, KEY_COL, T],
  );
  await pgRun(
    `CREATE TABLE IF NOT EXISTS "zugzug_app"."dim_d_canon_test" (${KEY_COL} varchar PRIMARY KEY, label varchar)`,
  );
  await pgRun(
    `CREATE TABLE IF NOT EXISTS "zugzug_app"."map_d_canon_test" (raw varchar, ${KEY_COL} varchar)`,
  );
  await pgRun(`DELETE FROM "zugzug_app"."dim_d_canon_test"`);
  await pgRun(`DELETE FROM "zugzug_app"."map_d_canon_test"`);
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE reference_table_id = $1`, [
    REF_TABLE,
  ]);
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials)
     VALUES ('u_canon_actor', 'Canon Actor', 'CA')
     ON CONFLICT (id) DO NOTHING`,
  );
});

afterAll(async () => {
  // Remove the refTable row so /api/refTables doesn't return a phantom test
  // refTable against a shared dev/test DB. dim_X/map_X tables stay orphaned but
  // invisible without the registry entry.
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE reference_table_id = $1`, [
    REF_TABLE,
  ]);
  await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE id = $1`, [REF_TABLE]);
});

test("addRecordOne seeds record_version row at version=1", async () => {
  await addRecordOne(REF_TABLE, "Denmark", "dk", "u_canon_actor", T);
  const v = await pgGet<{ version: number; updated_by: string }>(
    `SELECT version, updated_by FROM "zugzug_app"."record_version"
     WHERE reference_table_id = $1 AND key = $2`,
    [REF_TABLE, "dk"],
  );
  expect(v?.version).toBe(1);
  expect(v?.updated_by).toBe("u_canon_actor");
});

test("renameRecord with correct expectedVersion bumps to 2", async () => {
  // 'dk' was added at version=1 by the addRecordOne test above.
  await renameRecord(REF_TABLE, "dk", "Danmark", "u_canon_actor", 1, T);
  const v = await pgGet<{ version: number }>(
    `SELECT version FROM "zugzug_app"."record_version"
     WHERE reference_table_id = $1 AND key = $2`,
    [REF_TABLE, "dk"],
  );
  expect(v?.version).toBe(2);
  const label = await pgGet<{ label: string }>(
    `SELECT label FROM "zugzug_app"."dim_d_canon_test" WHERE ${KEY_COL} = 'dk'`,
  );
  expect(label?.label).toBe("Danmark");
});

test("renameRecord with stale expectedVersion throws CONFLICT", async () => {
  // 'dk' is now at version=2. Try to rename with version=1.
  let thrown: AppError | null = null;
  try {
    await renameRecord(REF_TABLE, "dk", "DenmarkAgain", "u_canon_actor", 1, T);
  } catch (e) {
    thrown = e as AppError;
  }
  expect(thrown).not.toBeNull();
  expect(thrown!.code).toBe("CONFLICT");
  expect(thrown!.status).toBe(409);
  const details = thrown!.details as { current: { version: number; updatedBy: { id: string } } };
  expect(details.current.version).toBe(2);
  expect(details.current.updatedBy.id).toBe("u_canon_actor");
  // Confirm dim_X label was NOT updated (rollback worked).
  const label = await pgGet<{ label: string }>(
    `SELECT label FROM "zugzug_app"."dim_d_canon_test" WHERE ${KEY_COL} = 'dk'`,
  );
  expect(label?.label).toBe("Danmark");
});

test("retireRecord with correct expectedVersion soft-retires version row", async () => {
  await addRecordOne(REF_TABLE, "Norway", "no", "u_canon_actor", T);
  const res = await retireRecord(REF_TABLE, "no", "u_canon_actor", 1, T);
  expect(res.ok).toBe(true);
  // Soft-delete: row persists with retired_at set; retired_into NULL (no merge target).
  const row = await pgGet<{
    key: string;
    retired_at: Date | null;
    retired_into: string | null;
  }>(
    `SELECT key, retired_at, retired_into FROM "zugzug_app"."record_version"
     WHERE reference_table_id = $1 AND key = $2`,
    [REF_TABLE, "no"],
  );
  expect(row).not.toBeNull();
  expect(row!.retired_at).not.toBeNull();
  expect(row!.retired_into).toBeNull();
});

test("retireRecord with stale expectedVersion throws CONFLICT", async () => {
  await addRecordOne(REF_TABLE, "Sweden", "se", "u_canon_actor", T);
  await renameRecord(REF_TABLE, "se", "Sverige", "u_canon_actor", 1, T);
  // Now version=2. Try to retire with version=1.
  let thrown: AppError | null = null;
  try {
    await retireRecord(REF_TABLE, "se", "u_canon_actor", 1, T);
  } catch (e) {
    thrown = e as AppError;
  }
  expect(thrown?.code).toBe("CONFLICT");
  const row = await pgGet<{ key: string }>(
    `SELECT ${KEY_COL} AS key FROM "zugzug_app"."dim_d_canon_test" WHERE ${KEY_COL} = 'se'`,
  );
  expect(row?.key).toBe("se");
});

test("retireRecord returns ok:false when variants still map (no version bump)", async () => {
  await addRecordOne(REF_TABLE, "Iceland", "is", "u_canon_actor", T);
  await pgRun(`INSERT INTO "zugzug_app"."map_d_canon_test" (raw, ${KEY_COL}) VALUES ('IS', 'is')`);
  const res = await retireRecord(REF_TABLE, "is", "u_canon_actor", 1, T);
  expect(res.ok).toBe(false);
  expect(res.variants).toBe(1);
  const v = await pgGet<{ version: number }>(
    `SELECT version FROM "zugzug_app"."record_version"
     WHERE reference_table_id = $1 AND key = $2`,
    [REF_TABLE, "is"],
  );
  expect(v?.version).toBe(1);
});

test("mergeRecord with correct expectedVersions merges and bumps each row", async () => {
  await addRecordOne(REF_TABLE, "Finland", "fi", "u_canon_actor", T);
  await addRecordOne(REF_TABLE, "FinlandAlt", "fi_alt", "u_canon_actor", T);
  await pgRun(
    `INSERT INTO "zugzug_app"."map_d_canon_test" (raw, ${KEY_COL}) VALUES ('Finland Alt', 'fi_alt')`,
  );
  const merged = await mergeRecord(
    REF_TABLE,
    "fi",
    ["fi_alt"],
    "u_canon_actor",
    { fi: 1, fi_alt: 1 },
    T,
  );
  expect(merged).toBe(1);
  const survivor = await pgGet<{ version: number }>(
    `SELECT version FROM "zugzug_app"."record_version"
     WHERE reference_table_id = $1 AND key = 'fi'`,
    [REF_TABLE],
  );
  expect(survivor?.version).toBe(2);
  const loserDim = await pgGet<{ key: string }>(
    `SELECT ${KEY_COL} AS key FROM "zugzug_app"."dim_d_canon_test" WHERE ${KEY_COL} = 'fi_alt'`,
  );
  expect(loserDim).toBeNull();
});

test("mergeRecord with one stale expectedVersion throws CONFLICT listing it", async () => {
  await addRecordOne(REF_TABLE, "Estonia", "ee", "u_canon_actor", T);
  await addRecordOne(REF_TABLE, "EstoniaAlt", "ee_alt", "u_canon_actor", T);
  // Bump ee_alt out of band so its expectedVersion is stale.
  await renameRecord(REF_TABLE, "ee_alt", "EstoniaAlt2", "u_canon_actor", 1, T);
  let thrown: AppError | null = null;
  try {
    await mergeRecord(
      REF_TABLE,
      "ee",
      ["ee_alt"],
      "u_canon_actor",
      { ee: 1, ee_alt: 1 }, // ee_alt is now at 2
      T,
    );
  } catch (e) {
    thrown = e as AppError;
  }
  expect(thrown?.code).toBe("CONFLICT");
  const details = thrown!.details as { conflictedKeys: string[] };
  expect(details.conflictedKeys).toContain("ee_alt");
  const stillThere = await pgGet<{ key: string }>(
    `SELECT ${KEY_COL} AS key FROM "zugzug_app"."dim_d_canon_test" WHERE ${KEY_COL} = 'ee_alt'`,
  );
  expect(stillThere?.key).toBe("ee_alt");
});
