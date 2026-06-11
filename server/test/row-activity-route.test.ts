process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";
import { getRowActivitySince } from "../src/repo-activity.ts";

beforeEach(async () => {
  await resetDb();
});

test("getRowActivitySince integration: dim with rows returns activity entries", async () => {
  const userId = "u_route_test";
  const dimId = await repo.addDimension("RouteTest", [], { keyKind: "slug" }, userId, "default");
  await repo.addCanonicalOne(dimId, "Item", undefined, userId, "default");
  const since = new Date(Date.now() - 60_000);
  const entries = await getRowActivitySince(dimId, since, "default");
  expect(entries.length).toBeGreaterThanOrEqual(1);
  expect(entries[0]?.rowKey).toBe("item");
  expect(entries[0]?.op).toBe("create");
});
