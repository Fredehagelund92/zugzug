// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";

beforeEach(async () => {
  await resetDb();
});

test("commit folds approved drafts into canonical", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Brand", [], { keyKind: "slug" }, userId);

  await repo.addCanonicalOne(dimId, "Acme", undefined, userId);
  await repo.saveDraft(dimId, "ACME Inc", "mapped", "Acme", "acme", userId);

  const result = await repo.commit(dimId, userId);
  expect(result.committed).toBe(1);

  const drafts = await repo.listDrafts(dimId);
  expect(drafts).toHaveLength(0);
});

test("commit writes one per-row audit entry per committed key + one rollup", async () => {
  const userId = "u_test_audit";
  const dimId = await repo.addDimension("AuditBrand", [], { keyKind: "slug" }, userId);

  await repo.addCanonicalOne(dimId, "Acme", undefined, userId);
  await repo.addCanonicalOne(dimId, "Globex", undefined, userId);
  await repo.saveDraft(dimId, "ACME Inc", "mapped", "Acme", "acme", userId);
  await repo.saveDraft(dimId, "acme inc.", "mapped", "Acme", "acme", userId);
  await repo.saveDraft(dimId, "Globex Corp", "mapped", "Globex", "globex", userId);

  const before = new Date();
  await repo.commit(dimId, userId);

  const audit = await repo.pgAll<{ action: string; table_id: string | null; row_key: string | null }>(
    `SELECT action, table_id, row_key FROM "zugzug_app"."audit_log"
     WHERE user_id = $1 AND created_at >= $2
     ORDER BY created_at DESC`,
    [userId, before],
  );

  const perRow = audit.filter((a) => a.action === "Committed mapping");
  const rollup = audit.filter((a) => a.action === "Committed");

  // Two distinct target_keys (acme + globex) → two per-row entries
  expect(perRow.length).toBeGreaterThanOrEqual(2);
  expect(rollup.length).toBeGreaterThanOrEqual(1);
  // Every per-row entry should carry table_id = dimId and a non-null row_key
  expect(perRow.every((a) => a.table_id === dimId && a.row_key !== null)).toBe(true);
});
