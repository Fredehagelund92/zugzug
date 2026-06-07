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

test("updateField fieldConfig merges with existing instead of replacing", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("MergeTest", [], {}, userId);
  await repo.addField(dimId, "Category", "select", undefined, { silent: true }, userId);

  // Step 1: set options on the select field
  const options = [
    { label: "alpha", color: "rose" as const },
    { label: "beta", color: "teal" as const },
  ];
  await repo.updateField(dimId, "category", { fieldConfig: JSON.stringify({ options }) }, userId);

  let dim = await repo.getDimension(dimId);
  let cat = dim?.fields.find((f) => f.field === "category");
  expect(cat?.options).toEqual(options);

  // Step 2: set rules — must NOT destroy options
  const rules = [
    {
      id: "r1",
      field: "category",
      trigger: { kind: "equals" as const, value: "alpha" },
      style: { rowStripe: "rose" as const },
    },
  ];
  await repo.updateField(dimId, "category", { fieldConfig: JSON.stringify({ rules }) }, userId);

  dim = await repo.getDimension(dimId);
  cat = dim?.fields.find((f) => f.field === "category");
  expect(cat?.options).toEqual(options); // still there
  expect(cat?.rules).toEqual(rules);     // also there
});

test("updateField fieldConfig merge: setting options does not wipe existing rules", async () => {
  const userId = "u_test";
  const dimId = await repo.addDimension("MergeTest2", [], {}, userId);
  await repo.addField(dimId, "Status", "select", undefined, { silent: true }, userId);

  // First write rules
  const rules = [
    {
      id: "r2",
      field: "status",
      trigger: { kind: "is_empty" as const },
      style: { rowStripe: "amber" as const },
    },
  ];
  await repo.updateField(dimId, "status", { fieldConfig: JSON.stringify({ rules }) }, userId);

  // Then overwrite options — rules should survive
  const options = [{ label: "open", color: null }, { label: "closed", color: null }];
  await repo.updateField(dimId, "status", { fieldConfig: JSON.stringify({ options }) }, userId);

  const dim = await repo.getDimension(dimId);
  const field = dim?.fields.find((f) => f.field === "status");
  expect(field?.options).toEqual(options);
  expect(field?.rules).toEqual(rules);
});
