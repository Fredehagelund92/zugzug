// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet } from "../src/pg.ts";
import { addCanonicalOne, renameCanonical, retireCanonical, mergeCanonical } from "../src/repo-canonical.ts";
import { AppError } from "../src/errors.ts";

const DIM = "d_canon_test";
const T = "default";
// Store unquoted identifiers — cq() will add quotes when building SQL
const DIM_TABLE = "zugzug_app.dim_d_canon_test";
const MAP_TABLE = "zugzug_app.map_d_canon_test";
const KEY_COL = "country_id";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension"
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (tenant_id, id) DO UPDATE SET label = EXCLUDED.label, dim_table = EXCLUDED.dim_table, map_table = EXCLUDED.map_table, key_col = EXCLUDED.key_col`,
    [DIM, "Canon Test", DIM_TABLE, MAP_TABLE, KEY_COL, T],
  );
  await pgRun(
    `CREATE TABLE IF NOT EXISTS "zugzug_app"."dim_d_canon_test" (${KEY_COL} varchar PRIMARY KEY, label varchar)`,
  );
  await pgRun(
    `CREATE TABLE IF NOT EXISTS "zugzug_app"."map_d_canon_test" (raw varchar, ${KEY_COL} varchar)`,
  );
  await pgRun(`DELETE FROM "zugzug_app"."dim_d_canon_test"`);
  await pgRun(`DELETE FROM "zugzug_app"."map_d_canon_test"`);
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE dim_id = $1`, [DIM]);
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials)
     VALUES ('u_canon_actor', 'Canon Actor', 'CA')
     ON CONFLICT (id) DO NOTHING`,
  );
});

afterAll(async () => {
  // Remove the dimension row so /api/dimensions doesn't return a phantom test
  // dim against a shared dev/test DB. dim_X/map_X tables stay orphaned but
  // invisible without the registry entry.
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE dim_id = $1`, [DIM]);
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE id = $1`, [DIM]);
});

test("addCanonicalOne seeds canonical_version row at version=1", async () => {
  await addCanonicalOne(DIM, "Denmark", "dk", "u_canon_actor", T);
  const v = await pgGet<{ version: number; updated_by: string }>(
    `SELECT version, updated_by FROM "zugzug_app"."canonical_version"
     WHERE dim_id = $1 AND key = $2`,
    [DIM, "dk"],
  );
  expect(v?.version).toBe(1);
  expect(v?.updated_by).toBe("u_canon_actor");
});

test("renameCanonical with correct expectedVersion bumps to 2", async () => {
  // 'dk' was added at version=1 by the addCanonicalOne test above.
  await renameCanonical(DIM, "dk", "Danmark", "u_canon_actor", 1, T);
  const v = await pgGet<{ version: number }>(
    `SELECT version FROM "zugzug_app"."canonical_version"
     WHERE dim_id = $1 AND key = $2`,
    [DIM, "dk"],
  );
  expect(v?.version).toBe(2);
  const label = await pgGet<{ label: string }>(
    `SELECT label FROM "zugzug_app"."dim_d_canon_test" WHERE ${KEY_COL} = 'dk'`,
  );
  expect(label?.label).toBe("Danmark");
});

test("renameCanonical with stale expectedVersion throws CONFLICT", async () => {
  // 'dk' is now at version=2. Try to rename with version=1.
  let thrown: AppError | null = null;
  try {
    await renameCanonical(DIM, "dk", "DenmarkAgain", "u_canon_actor", 1, T);
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

test("retireCanonical with correct expectedVersion deletes row + version", async () => {
  await addCanonicalOne(DIM, "Norway", "no", "u_canon_actor", T);
  const res = await retireCanonical(DIM, "no", "u_canon_actor", 1, T);
  expect(res.ok).toBe(true);
  const stillThere = await pgGet<{ key: string }>(
    `SELECT key FROM "zugzug_app"."canonical_version"
     WHERE dim_id = $1 AND key = $2`,
    [DIM, "no"],
  );
  expect(stillThere).toBeNull();
});

test("retireCanonical with stale expectedVersion throws CONFLICT", async () => {
  await addCanonicalOne(DIM, "Sweden", "se", "u_canon_actor", T);
  await renameCanonical(DIM, "se", "Sverige", "u_canon_actor", 1, T);
  // Now version=2. Try to retire with version=1.
  let thrown: AppError | null = null;
  try {
    await retireCanonical(DIM, "se", "u_canon_actor", 1, T);
  } catch (e) {
    thrown = e as AppError;
  }
  expect(thrown?.code).toBe("CONFLICT");
  const row = await pgGet<{ key: string }>(
    `SELECT ${KEY_COL} AS key FROM "zugzug_app"."dim_d_canon_test" WHERE ${KEY_COL} = 'se'`,
  );
  expect(row?.key).toBe("se");
});

test("retireCanonical returns ok:false when variants still map (no version bump)", async () => {
  await addCanonicalOne(DIM, "Iceland", "is", "u_canon_actor", T);
  await pgRun(`INSERT INTO "zugzug_app"."map_d_canon_test" (raw, ${KEY_COL}) VALUES ('IS', 'is')`);
  const res = await retireCanonical(DIM, "is", "u_canon_actor", 1, T);
  expect(res.ok).toBe(false);
  expect(res.variants).toBe(1);
  const v = await pgGet<{ version: number }>(
    `SELECT version FROM "zugzug_app"."canonical_version"
     WHERE dim_id = $1 AND key = $2`,
    [DIM, "is"],
  );
  expect(v?.version).toBe(1);
});

test("mergeCanonical with correct expectedVersions merges and bumps each row", async () => {
  await addCanonicalOne(DIM, "Finland", "fi", "u_canon_actor", T);
  await addCanonicalOne(DIM, "FinlandAlt", "fi_alt", "u_canon_actor", T);
  await pgRun(`INSERT INTO "zugzug_app"."map_d_canon_test" (raw, ${KEY_COL}) VALUES ('Finland Alt', 'fi_alt')`);
  const merged = await mergeCanonical(
    DIM,
    "fi",
    ["fi_alt"],
    "u_canon_actor",
    { fi: 1, fi_alt: 1 },
    T,
  );
  expect(merged).toBe(1);
  const survivor = await pgGet<{ version: number }>(
    `SELECT version FROM "zugzug_app"."canonical_version"
     WHERE dim_id = $1 AND key = 'fi'`,
    [DIM],
  );
  expect(survivor?.version).toBe(2);
  const loserDim = await pgGet<{ key: string }>(
    `SELECT ${KEY_COL} AS key FROM "zugzug_app"."dim_d_canon_test" WHERE ${KEY_COL} = 'fi_alt'`,
  );
  expect(loserDim).toBeNull();
});

test("mergeCanonical with one stale expectedVersion throws CONFLICT listing it", async () => {
  await addCanonicalOne(DIM, "Estonia", "ee", "u_canon_actor", T);
  await addCanonicalOne(DIM, "EstoniaAlt", "ee_alt", "u_canon_actor", T);
  // Bump ee_alt out of band so its expectedVersion is stale.
  await renameCanonical(DIM, "ee_alt", "EstoniaAlt2", "u_canon_actor", 1, T);
  let thrown: AppError | null = null;
  try {
    await mergeCanonical(
      DIM,
      "ee",
      ["ee_alt"],
      "u_canon_actor",
      { ee: 1, ee_alt: 1 },  // ee_alt is now at 2
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
