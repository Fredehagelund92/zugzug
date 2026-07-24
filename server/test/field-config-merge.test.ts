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

test("updateField fieldConfig merges with existing instead of replacing", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("MergeTest", [], {}, userId, "default");
  await repo.addField(
    refTableId,
    "Category",
    "select",
    undefined,
    { silent: true },
    userId,
    "default",
  );

  // Step 1: set options on the select field
  const options = [
    { label: "alpha", color: "rose" as const },
    { label: "beta", color: "teal" as const },
  ];
  await repo.updateField(
    refTableId,
    "category",
    { fieldConfig: JSON.stringify({ options }) },
    userId,
    "default",
  );

  let refTable = await repo.getRefTable(refTableId, "default");
  let cat = refTable?.fields.find((f) => f.field === "category");
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
  await repo.updateField(
    refTableId,
    "category",
    { fieldConfig: JSON.stringify({ rules }) },
    userId,
    "default",
  );

  refTable = await repo.getRefTable(refTableId, "default");
  cat = refTable?.fields.find((f) => f.field === "category");
  expect(cat?.options).toEqual(options); // still there
  expect(cat?.rules).toEqual(rules); // also there
});

test("updateField fieldConfig merge: setting options does not wipe existing rules", async () => {
  const userId = "u_test";
  const refTableId = await repo.addRefTable("MergeTest2", [], {}, userId, "default");
  await repo.addField(
    refTableId,
    "Status",
    "select",
    undefined,
    { silent: true },
    userId,
    "default",
  );

  // First write rules
  const rules = [
    {
      id: "r2",
      field: "status",
      trigger: { kind: "is_empty" as const },
      style: { rowStripe: "amber" as const },
    },
  ];
  await repo.updateField(
    refTableId,
    "status",
    { fieldConfig: JSON.stringify({ rules }) },
    userId,
    "default",
  );

  // Then overwrite options — rules should survive
  const options = [
    { label: "open", color: null },
    { label: "closed", color: null },
  ];
  await repo.updateField(
    refTableId,
    "status",
    { fieldConfig: JSON.stringify({ options }) },
    userId,
    "default",
  );

  const refTable = await repo.getRefTable(refTableId, "default");
  const field = refTable?.fields.find((f) => f.field === "status");
  expect(field?.options).toEqual(options);
  expect(field?.rules).toEqual(rules);
});
