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
