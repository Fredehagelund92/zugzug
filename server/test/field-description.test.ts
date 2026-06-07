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

test("field description round-trip", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("DescTest", [], {}, userId);

  await repo.addField(dimId, "X", "text", undefined, { silent: true }, userId);

  // Set a description
  await repo.updateField(dimId, "x", { description: "an explanation" });
  const dim = await repo.getDimension(dimId);
  expect(dim?.fields.find((f) => f.field === "x")?.description).toBe("an explanation");

  // Clear the description
  await repo.updateField(dimId, "x", { description: null });
  const dim2 = await repo.getDimension(dimId);
  expect(dim2?.fields.find((f) => f.field === "x")?.description).toBeUndefined();
});

test("updateField with undefined description is a no-op", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("DescNoOp", [], {}, userId);

  await repo.addField(dimId, "Y", "text", undefined, { silent: true }, userId);
  await repo.updateField(dimId, "y", { description: "original" });

  // Passing undefined should leave description unchanged
  await repo.updateField(dimId, "y", {});
  const dim = await repo.getDimension(dimId);
  expect(dim?.fields.find((f) => f.field === "y")?.description).toBe("original");
});
