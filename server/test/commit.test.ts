// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";

beforeEach(async () => {
  await resetDb();
});

test("commit folds approved drafts into canonical", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Brand", [], { keyKind: "slug" }, userId, "default");

  await repo.addCanonicalOne(dimId, "Acme", undefined, userId, "default");
  await repo.saveDraft(dimId, "ACME Inc", "mapped", "Acme", "acme", userId, "default");

  const result = await repo.commit(dimId, userId, "default");
  expect(result.committed).toBe(1);

  const drafts = await repo.listDrafts(dimId, "default");
  expect(drafts).toHaveLength(0);
});

test("commit writes one per-row audit entry per committed key + one rollup", async () => {
  const userId = "u_test_audit";
  const dimId = await repo.addDimension("AuditBrand", [], { keyKind: "slug" }, userId, "default");

  await repo.addCanonicalOne(dimId, "Acme", undefined, userId, "default");
  await repo.addCanonicalOne(dimId, "Globex", undefined, userId, "default");
  await repo.saveDraft(dimId, "ACME Inc", "mapped", "Acme", "acme", userId, "default");
  await repo.saveDraft(dimId, "acme inc.", "mapped", "Acme", "acme", userId, "default");
  await repo.saveDraft(dimId, "Globex Corp", "mapped", "Globex", "globex", userId, "default");

  // DB clock, not host clock — created_at is stamped by Postgres, and even a
  // few ms of host↔container skew makes a host-side `new Date()` flaky here.
  const before = (await repo.pgGet<{ t: Date }>(`SELECT now() AS t`))!.t;
  await repo.commit(dimId, userId, "default");

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
