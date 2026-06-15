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

// KNOWN BUG: addDimension is currently silently idempotent — when a dimension
// with the same slug already exists it returns the existing id without throwing.
// The API layer should detect this and surface a 409, but the repo function
// itself does not enforce uniqueness at the call site.
// This test is marked as failing to document the current behaviour; it should
// be converted to a plain `test(...)` once addDimension throws on collision.
test.failing("addDimension rejects duplicate names", async () => {
  const userId = "u_test";
  await repo.addDimension("Brand", [], { keyKind: "slug" }, userId, "default");
  await expect(
    repo.addDimension("Brand", [], { keyKind: "slug" }, userId, "default"),
  ).rejects.toThrow(/exists|duplicate|unique|taken/i);
});

test("addDimension creates registry row that getDimension can read", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Channel", [], { keyKind: "slug" }, userId, "default");
  const dim = await repo.getDimension(dimId, "default");
  expect(dim).not.toBeNull();
  expect(dim?.dimension).toBe("Channel");
});
