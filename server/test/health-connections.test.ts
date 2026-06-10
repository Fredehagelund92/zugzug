process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect } from "bun:test";
import { checkHealth, _resetHealthCache } from "../src/health.ts";

test("checkHealth returns ok for postgres when reachable", async () => {
  _resetHealthCache();
  const out = await checkHealth();
  expect(out.postgres.status).toBe("ok");
  expect(typeof out.postgres.lastCheckedAt).toBe("string");
});

test("checkHealth returns disabled for warehouse when ATTACH_WAREHOUSE=false", async () => {
  _resetHealthCache();
  const out = await checkHealth();
  expect(out.warehouse.status).toBe("disabled");
});

test("checkHealth caches results for 5 seconds", async () => {
  _resetHealthCache();
  const a = await checkHealth();
  const b = await checkHealth();
  expect(b.postgres.lastCheckedAt).toBe(a.postgres.lastCheckedAt);
});

test("checkHealth({ force: true }) bypasses cache", async () => {
  _resetHealthCache();
  const a = await checkHealth();
  await new Promise((r) => setTimeout(r, 10));
  const b = await checkHealth({ force: true });
  expect(b.postgres.lastCheckedAt).not.toBe(a.postgres.lastCheckedAt);
});
