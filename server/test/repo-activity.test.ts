process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";
import { getRowActivitySince } from "../src/repo-activity.ts";

beforeEach(async () => {
  await resetDb();
});

test("getRowActivitySince returns latest entry per row_key within window", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, userId, "default");

  await repo.addCanonicalOne(dimId, "United States", undefined, userId, "default");
  await repo.addCanonicalOne(dimId, "Germany",       undefined, userId, "default");
  await repo.renameCanonical(dimId, "united_states", "USA", userId, 1, "default");

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const entries = await getRowActivitySince(dimId, since, "default");

  expect(entries).toHaveLength(2);
  const usa = entries.find((e) => e.rowKey === "united_states");
  expect(usa?.op).toBe("rename");
  expect(usa?.displayName).toBeDefined();
});

test("getRowActivitySince ignores entries older than `since`", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("Brand", [], { keyKind: "slug" }, userId, "default");
  await repo.addCanonicalOne(dimId, "Acme", undefined, userId, "default");

  const future = new Date(Date.now() + 60_000);
  const entries = await getRowActivitySince(dimId, future, "default");
  expect(entries).toHaveLength(0);
});

test("getRowActivitySince filters by tableId", async () => {
  const userId = "u_test";
  const dimA = await repo.addDimension("A", [], { keyKind: "slug" }, userId, "default");
  const dimB = await repo.addDimension("B", [], { keyKind: "slug" }, userId, "default");
  await repo.addCanonicalOne(dimA, "x", undefined, userId, "default");
  await repo.addCanonicalOne(dimB, "y", undefined, userId, "default");

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const a = await getRowActivitySince(dimA, since, "default");
  const b = await getRowActivitySince(dimB, since, "default");
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  expect(a[0]?.rowKey).not.toBe(b[0]?.rowKey);
});
