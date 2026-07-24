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

// KNOWN BUG: addRefTable is currently silently idempotent — when a refTable
// with the same slug already exists it returns the existing id without throwing.
// The API layer should detect this and surface a 409, but the repo function
// itself does not enforce uniqueness at the call site.
// This test is marked as failing to document the current behaviour; it should
// be converted to a plain `test(...)` once addRefTable throws on collision.
test.failing("addRefTable rejects duplicate names", async () => {
  const userId = "u_test";
  await repo.addRefTable("Brand", [], { keyKind: "slug" }, userId, "default");
  await expect(
    repo.addRefTable("Brand", [], { keyKind: "slug" }, userId, "default"),
  ).rejects.toThrow(/exists|duplicate|unique|taken/i);
});

test("addRefTable creates registry row that getRefTable can read", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("Channel", [], { keyKind: "slug" }, userId, "default");
  const refTable = await repo.getRefTable(refTableId, "default");
  expect(refTable).not.toBeNull();
  expect(refTable?.refTable).toBe("Channel");
});
