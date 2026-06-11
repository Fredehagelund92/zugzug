process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { TenantRepo } from "../src/tenant-repo.ts";
import { AppError } from "../src/errors.ts";

const T_IDS = ["tpref_a", "tpref_b"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

test("setPreferences + getPreferences round-trip per tenant", async () => {
  await provisionTenant({ id: "tpref_a", label: "A" });
  const repo = new TenantRepo("tpref_a", "admin");

  await repo.setPreferences({
    publishThreshold: 90,
    suggestThreshold: 70,
    scanSchedule: "hourly",
  });

  const got = await repo.getPreferences();
  expect(got).toEqual({
    publishThreshold: 90,
    suggestThreshold: 70,
    scanSchedule: "hourly",
  });
});

test("tenant A preferences are independent from tenant B preferences", async () => {
  await provisionTenant({ id: "tpref_a", label: "A" });
  await provisionTenant({ id: "tpref_b", label: "B" });

  const a = new TenantRepo("tpref_a", "admin");
  const b = new TenantRepo("tpref_b", "admin");

  await a.setPreferences({ publishThreshold: 80, suggestThreshold: 60, scanSchedule: "15m" });
  await b.setPreferences({ publishThreshold: 99, suggestThreshold: 90, scanSchedule: "daily" });

  const gotA = await a.getPreferences();
  const gotB = await b.getPreferences();

  expect(gotA.publishThreshold).toBe(80);
  expect(gotA.scanSchedule).toBe("15m");
  expect(gotB.publishThreshold).toBe(99);
  expect(gotB.scanSchedule).toBe("daily");
});

test("setPreferences as viewer → 403 FORBIDDEN", async () => {
  await provisionTenant({ id: "tpref_a", label: "A" });
  const viewer = new TenantRepo("tpref_a", "viewer");
  let thrown: AppError | null = null;
  try {
    await viewer.setPreferences({
      publishThreshold: 1,
      suggestThreshold: 1,
      scanSchedule: null,
    });
  } catch (e) {
    if (e instanceof AppError) thrown = e;
  }
  expect(thrown?.code).toBe("FORBIDDEN");
});

test("super-admin bypasses the role check even with role='viewer'", async () => {
  await provisionTenant({ id: "tpref_a", label: "A" });
  const sa = new TenantRepo("tpref_a", "viewer", true);
  await sa.setPreferences({ publishThreshold: 50, suggestThreshold: 50, scanSchedule: null });
  expect((await sa.getPreferences()).publishThreshold).toBe(50);
});

test("default tenant getPreferences still returns the legacy id=1 row when no tenant_id row exists", async () => {
  const defaultRepo = new TenantRepo("default", "admin");
  const prefs = await defaultRepo.getPreferences();
  expect(prefs.publishThreshold).toBeGreaterThanOrEqual(0);
});
