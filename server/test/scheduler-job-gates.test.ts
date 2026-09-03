// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import "./setup.ts";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { makeWorkspace } from "./factories/index.ts";
import { createScheduler, type SchedulerJob } from "../src/scheduler.ts";
import { scanSourcesJob } from "../src/scheduler-jobs.ts";
import { TenantRepo } from "../src/tenant-repo.ts";

/* Scans "Off" (preferences.scan_schedule IS NULL) used to gate the WHOLE tenant
   tick, so auto-matching and auto-publishing silently stopped with it. Each job
   now carries its own gate. */

const T = "tsgate";

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."scan_run" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
}
beforeEach(async () => {
  await cleanup();
  await makeWorkspace(T);
  await setSchedule(null);
});

/** Scans "Off" is scan_schedule IS NULL. */
async function setSchedule(schedule: string | null): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."preferences"
       (publish_threshold, suggest_threshold, scan_schedule, updated_at, tenant_id)
     VALUES (90, 70, $2, now(), $1)
     ON CONFLICT (tenant_id) DO UPDATE SET scan_schedule = EXCLUDED.scan_schedule`,
    [T, schedule],
  );
}
afterAll(cleanup);

function recorder(name: string, ran: string[]): SchedulerJob {
  return {
    name,
    run: async () => {
      ran.push(name);
      return {};
    },
  };
}

test("scans Off stops the scan job — and nothing else", async () => {
  expect(await new TenantRepo(T, "admin", true).anyScanDue(new Date())).toBe(false);

  const ran: string[] = [];
  const sched = createScheduler({
    tickIntervalMs: 1_000_000,
    listTenants: async () => [{ id: T }],
    jobs: [
      { ...scanSourcesJob, run: async () => (ran.push("scan-sources"), {}) },
      recorder("auto-stage-exact-matches", ran),
      recorder("auto-commit", ran),
    ],
  });
  await sched._tick();
  await sched.stop(1_000);

  expect(ran).toEqual(["auto-stage-exact-matches", "auto-commit"]);
});

test("with a schedule set, the scan job runs alongside the others", async () => {
  await setSchedule("daily");
  const ran: string[] = [];
  const sched = createScheduler({
    tickIntervalMs: 1_000_000,
    listTenants: async () => [{ id: T }],
    jobs: [
      { ...scanSourcesJob, run: async () => (ran.push("scan-sources"), {}) },
      recorder("auto-commit", ran),
    ],
  });
  await sched._tick();
  await sched.stop(1_000);

  expect(ran).toEqual(["scan-sources", "auto-commit"]);
});
