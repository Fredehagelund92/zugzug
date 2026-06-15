process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import "./setup.ts";
import { test, expect, afterAll, beforeEach } from "bun:test";
import { pgContext, pgAll, pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { TenantRepo } from "../src/tenant-repo.ts";

const T = "tprx";
async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
}
beforeEach(cleanup);
afterAll(cleanup);

test("direct pgAll inside the route handler ctx throws", async () => {
  let thrown: Error | null = null;
  try {
    await pgContext.run({ insideTenantRepo: true }, async () => {
      await pgAll(`SELECT 1`);
    });
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown).not.toBeNull();
  expect(thrown?.message).toContain("TenantRepo");
});

test("pgAll inside a TenantRepo forwarder does NOT throw (withClearCtx restores)", async () => {
  await provisionTenant({ id: T, label: "X" });
  const repo = new TenantRepo(T, "admin");
  await pgContext.run({ insideTenantRepo: true }, async () => {
    await repo.listDimensions(); // calls pgAll internally via repo-canonical
  });
});

test("pgAll OUTSIDE any context (scheduler boot, tests) does not throw", async () => {
  await pgAll(`SELECT 1`); // unwrapped — production-style call path
});

test("guard is disabled when NODE_ENV=production", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await pgContext.run({ insideTenantRepo: true }, async () => {
      await pgAll(`SELECT 1`); // would throw in dev/test; allowed in prod
    });
  } finally {
    process.env.NODE_ENV = prev;
  }
});
