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

test("field description round-trip", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("DescTest", [], {}, userId, "default");

  await repo.addField(refTableId, "X", "text", undefined, { silent: true }, userId, "default");

  // Set a description
  await repo.updateField(refTableId, "x", { description: "an explanation" }, userId, "default");
  const refTable = await repo.getRefTable(refTableId, "default");
  expect(refTable?.fields.find((f) => f.field === "x")?.description).toBe("an explanation");

  // Clear the description
  await repo.updateField(refTableId, "x", { description: null }, userId, "default");
  const dim2 = await repo.getRefTable(refTableId, "default");
  expect(dim2?.fields.find((f) => f.field === "x")?.description).toBeUndefined();
});

test("updateField with undefined description is a no-op", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("DescNoOp", [], {}, userId, "default");

  await repo.addField(refTableId, "Y", "text", undefined, { silent: true }, userId, "default");
  await repo.updateField(refTableId, "y", { description: "original" }, userId, "default");

  // Passing undefined should leave description unchanged
  await repo.updateField(refTableId, "y", {}, userId, "default");
  const refTable = await repo.getRefTable(refTableId, "default");
  expect(refTable?.fields.find((f) => f.field === "y")?.description).toBe("original");
});
