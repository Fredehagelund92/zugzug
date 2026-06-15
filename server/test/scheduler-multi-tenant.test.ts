// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import "./setup.ts";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { createScheduler, type SchedulerJob } from "../src/scheduler.ts";

const T_IDS = ["tsch_a", "tsch_b"];
async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."scan_run" WHERE source_id LIKE $1`, [`${t}:%`]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

test("scheduler._tick runs each job once per tenant per tick", async () => {
  await provisionTenant({ id: "tsch_a", label: "A" });
  await provisionTenant({ id: "tsch_b", label: "B" });

  const ran: Array<{ tenantId: string; jobName: string }> = [];
  const fakeJob: SchedulerJob = {
    name: "fake",
    run: async (ctx) => {
      ran.push({ tenantId: ctx.tenantId, jobName: "fake" });
      return {};
    },
  };

  const sched = createScheduler({
    tickIntervalMs: 1_000_000,
    listTenants: async () => [{ id: "tsch_a" }, { id: "tsch_b" }],
    shouldRun: async () => true,
    jobs: [fakeJob],
  });
  await sched._tick();
  expect(ran.map((r) => r.tenantId).sort()).toEqual(["tsch_a", "tsch_b"]);
});

test("shouldRun(tenantId) gates per-tenant — false skips that tenant", async () => {
  await provisionTenant({ id: "tsch_a", label: "A" });
  await provisionTenant({ id: "tsch_b", label: "B" });

  const ran: string[] = [];
  const sched = createScheduler({
    tickIntervalMs: 1_000_000,
    listTenants: async () => [{ id: "tsch_a" }, { id: "tsch_b" }],
    shouldRun: async (tenantId) => tenantId === "tsch_a",
    jobs: [
      {
        name: "fake",
        run: async (ctx) => {
          ran.push(ctx.tenantId);
          return {};
        },
      },
    ],
  });
  await sched._tick();
  expect(ran).toEqual(["tsch_a"]);
});

test("scheduler ctx.repo is a TenantRepo bound to ctx.tenantId", async () => {
  await provisionTenant({ id: "tsch_a", label: "A" });
  let capturedRepo: unknown = null;
  const sched = createScheduler({
    tickIntervalMs: 1_000_000,
    listTenants: async () => [{ id: "tsch_a" }],
    shouldRun: async () => true,
    jobs: [
      {
        name: "probe",
        run: async (ctx) => {
          capturedRepo = ctx.repo;
          return {};
        },
      },
    ],
  });
  await sched._tick();
  expect(capturedRepo).toBeDefined();
  // Confirm it's a TenantRepo (duck-type)
  expect((capturedRepo as { tenantId: string }).tenantId).toBe("tsch_a");
});
