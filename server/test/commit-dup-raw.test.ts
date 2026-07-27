process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";
import { cq } from "../src/repo-shared.ts";

beforeEach(async () => {
  await resetDb();
});

async function mapRawCount(refTableId: string): Promise<number> {
  const meta = await repo.pgGet<{ mapTable: string }>(
    `SELECT map_table AS "mapTable" FROM "zugzug_app"."reference_table" WHERE id = $1`,
    [refTableId],
  );
  const rows = await repo.pgAll<{ raw: string }>(`SELECT raw FROM ${cq(meta!.mapTable)}`);
  return rows.length;
}

// Regression: two editors independently mapping the identical raw before either
// publishes used to violate the map table's raw PK on commit (500 duplicate key).
// Draft PK is (tenant, refTable, raw, user_id) → both draft rows coexist and the
// fold must collapse them to one map row.
test("commit folds the same raw mapped by two editors into one map row", async () => {
  const refTableId = await repo.addRefTable("Channel", [], { keyKind: "slug" }, "u_a", "default");
  await repo.addRecordOne(refTableId, "Paid Social", undefined, "u_a", "default");

  await repo.saveDraft(refTableId, "Paid Social", "mapped", "Paid Social", "paid-social", "u_a", "default");
  await repo.saveDraft(refTableId, "Paid Social", "mapped", "Paid Social", "paid-social", "u_b", "default");

  const result = await repo.commit(refTableId, "u_a", "default");
  expect(result.committed).toBeGreaterThan(0);

  expect(await mapRawCount(refTableId)).toBe(1);
});

// Case-variant raws ("Google"/"google") also collapse — the map fold and its
// NOT EXISTS guard are both case-insensitive.
test("commit collapses case-variant raws from two editors into one map row", async () => {
  const refTableId = await repo.addRefTable("Source", [], { keyKind: "slug" }, "u_a", "default");
  await repo.addRecordOne(refTableId, "Google", undefined, "u_a", "default");

  await repo.saveDraft(refTableId, "Google", "mapped", "Google", "google", "u_a", "default");
  await repo.saveDraft(refTableId, "google", "mapped", "Google", "google", "u_b", "default");

  await repo.commit(refTableId, "u_a", "default");

  expect(await mapRawCount(refTableId)).toBe(1);
});
