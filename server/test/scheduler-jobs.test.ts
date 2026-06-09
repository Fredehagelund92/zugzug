// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect } from "bun:test";
import { scanSourcesJob, autoStageJob, autoCommitJob } from "../src/scheduler-jobs.ts";

const ctx = { signal: new AbortController().signal };

test("scanSourcesJob.run() returns rowsScanned: 0 on empty DB", async () => {
  const result = await scanSourcesJob.run(ctx);
  expect(result).toEqual({ rowsScanned: 0 });
});

test("autoStageJob.run() is a no-op when ATTACH_WAREHOUSE is false", async () => {
  // env.attachWarehouse is false in this test env (ATTACH_WAREHOUSE=false above)
  const result = await autoStageJob.run(ctx);
  expect(result).toEqual({});
});

test("autoCommitJob.run() is a no-op when ATTACH_WAREHOUSE is false", async () => {
  // env.attachWarehouse is false in this test env (ATTACH_WAREHOUSE=false above)
  const result = await autoCommitJob.run(ctx);
  expect(result).toEqual({});
});

test("the three jobs run independently when invoked individually", async () => {
  // Ensures none throw when run in sequence on a real (empty) DB
  await expect(scanSourcesJob.run(ctx)).resolves.toBeDefined();
  await expect(autoStageJob.run(ctx)).resolves.toBeDefined();
  await expect(autoCommitJob.run(ctx)).resolves.toBeDefined();
});
