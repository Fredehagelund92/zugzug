// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";

// MappingRefTable.record shape: RecordValue[]
// Each entry: { key: string, label: string, variants: number, fields: Record<string,string|null>, unresolved: boolean }

beforeEach(async () => {
  await resetDb();
});

test("mergeRecord re-points crosswalk rows and deletes losers", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("Brand", [], { keyKind: "slug" }, userId, "default");
  await repo.addRecordOne(refTableId, "Acme", undefined, userId, "default");
  await repo.addRecordOne(refTableId, "Acme Corp", undefined, userId, "default");

  await repo.saveDraft(
    refTableId,
    "acme corp variant",
    "mapped",
    "Acme Corp",
    "acme_corp",
    userId,
    "default",
  );
  await repo.commit(refTableId, userId, "default");

  const merged = await repo.mergeRecord(
    refTableId,
    "acme",
    ["acme_corp"],
    userId,
    { acme: 1, acme_corp: 1 },
    "default",
  );
  expect(merged).toBe(1);

  const refTable = await repo.getRefTable(refTableId, "default");
  expect(refTable?.record.map((c) => c.key).sort()).toEqual(["acme"]);
});

test("mergeRecord with empty losers is a no-op", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("Brand", [], { keyKind: "slug" }, userId, "default");
  const n = await repo.mergeRecord(refTableId, "acme", [], userId, {}, "default");
  expect(n).toBe(0);
});

test("mergeRecord filters out survivor from losers list", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("Brand", [], { keyKind: "slug" }, userId, "default");
  await repo.addRecordOne(refTableId, "Acme", undefined, userId, "default");
  // Survivor appearing in losers should be filtered out (no-op for that entry).
  const n = await repo.mergeRecord(refTableId, "acme", ["acme"], userId, { acme: 1 }, "default");
  expect(n).toBe(0);
});
