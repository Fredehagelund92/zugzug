process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

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
    scanSchedule: "hourly",
    requireSecondPublisher: false,
  });

  const got = await repo.getPreferences();
  expect(got).toEqual({
    scanSchedule: "hourly",
    requireSecondPublisher: false,
    autoPublishEnabled: false,
  });
});

test("tenant A preferences are independent from tenant B preferences", async () => {
  await provisionTenant({ id: "tpref_a", label: "A" });
  await provisionTenant({ id: "tpref_b", label: "B" });

  const a = new TenantRepo("tpref_a", "admin");
  const b = new TenantRepo("tpref_b", "admin");

  await a.setPreferences({ scanSchedule: "hourly", requireSecondPublisher: true });
  await b.setPreferences({ scanSchedule: "daily", requireSecondPublisher: false });

  const gotA = await a.getPreferences();
  const gotB = await b.getPreferences();

  expect(gotA.requireSecondPublisher).toBe(true);
  expect(gotA.scanSchedule).toBe("hourly");
  expect(gotB.requireSecondPublisher).toBe(false);
  expect(gotB.scanSchedule).toBe("daily");
});

test("setPreferences as viewer → 403 FORBIDDEN", async () => {
  await provisionTenant({ id: "tpref_a", label: "A" });
  const viewer = new TenantRepo("tpref_a", "viewer");
  let thrown: AppError | null = null;
  try {
    await viewer.setPreferences({
      scanSchedule: null,
      requireSecondPublisher: false,
    });
  } catch (e) {
    if (e instanceof AppError) thrown = e;
  }
  expect(thrown?.code).toBe("FORBIDDEN");
});

test("super-admin bypasses the role check even with role='viewer'", async () => {
  await provisionTenant({ id: "tpref_a", label: "A" });
  const sa = new TenantRepo("tpref_a", "viewer", true);
  await sa.setPreferences({
    scanSchedule: "daily",
    requireSecondPublisher: false,
  });
  expect((await sa.getPreferences()).scanSchedule).toBe("daily");
});

test("default tenant getPreferences returns hardcoded fallback when no preferences row exists", async () => {
  await pgRun(
    `DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = 'default' OR tenant_id IS NULL`,
  );
  const defaultRepo = new TenantRepo("default", "admin");
  const prefs = await defaultRepo.getPreferences();
  expect(prefs.scanSchedule).toBeNull();
  expect(prefs.requireSecondPublisher).toBe(false);
  expect(prefs.autoPublishEnabled).toBe(false);
});
