// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import "./setup.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { TenantRepo } from "../src/tenant-repo.ts";
import { scanSourcesJob, autoStageJob, autoCommitJob } from "../src/scheduler-jobs.ts";
// env.attachWarehouse is read at module-load time from .env (which may set ATTACH_WAREHOUSE=true).
// Override it here so no-op tests reflect the test's intended env.
import { env } from "../src/env.ts";

const T_ID = "tsjobs";
async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T_ID]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T_ID]);
}

beforeAll(async () => {
  await cleanup();
  await provisionTenant({ id: T_ID, label: "Jobs" });
});
afterAll(cleanup);

const ctx = {
  signal: new AbortController().signal,
  tenantId: T_ID,
  repo: new TenantRepo(T_ID, "admin", true),
};

test("scanSourcesJob.run() returns rowsScanned: 0 on empty DB", async () => {
  const result = await scanSourcesJob.run(ctx);
  expect(result).toEqual({ rowsScanned: 0 });
});

test("autoStageJob.run() is a no-op when ATTACH_WAREHOUSE is false", async () => {
  // env.attachWarehouse may be true from server/.env; force it false for this test.
  const saved = env.attachWarehouse;
  (env as { attachWarehouse: boolean }).attachWarehouse = false;
  try {
    const result = await autoStageJob.run(ctx);
    expect(result).toEqual({});
  } finally {
    (env as { attachWarehouse: boolean }).attachWarehouse = saved;
  }
});

test("autoCommitJob.run() is a no-op when ATTACH_WAREHOUSE is false", async () => {
  // env.attachWarehouse may be true from server/.env; force it false for this test.
  const saved = env.attachWarehouse;
  (env as { attachWarehouse: boolean }).attachWarehouse = false;
  try {
    const result = await autoCommitJob.run(ctx);
    expect(result).toEqual({});
  } finally {
    (env as { attachWarehouse: boolean }).attachWarehouse = saved;
  }
});

test("the three jobs run independently when invoked individually", async () => {
  // Ensures none throw when run in sequence on a real (empty) DB
  await expect(scanSourcesJob.run(ctx)).resolves.toBeDefined();
  await expect(autoStageJob.run(ctx)).resolves.toBeDefined();
  await expect(autoCommitJob.run(ctx)).resolves.toBeDefined();
});
