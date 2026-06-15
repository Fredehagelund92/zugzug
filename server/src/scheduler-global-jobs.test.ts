import { describe, it, expect } from "bun:test";
import { createScheduler, type SchedulerJob, type JobContext } from "./scheduler.ts";

describe("createScheduler — global vs per-tenant jobs", () => {
  it("runs global jobs once per tick regardless of tenant count", async () => {
    let perTenantCalls = 0;
    let globalCalls = 0;

    const perTenant: SchedulerJob = {
      name: "per-tenant",
      async run(_ctx: JobContext) {
        perTenantCalls++;
        return {};
      },
    };
    const global: SchedulerJob = {
      name: "global",
      scope: "global",
      async run(_ctx: JobContext) {
        globalCalls++;
        return {};
      },
    };

    const sch = createScheduler({
      jobs: [perTenant, global],
      tickIntervalMs: 1_000_000,
      listTenants: async () => [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
    });
    await sch._tick();
    expect(perTenantCalls).toBe(3);
    expect(globalCalls).toBe(1);
  });

  it("global jobs receive a special context (tenantId='*')", async () => {
    let receivedTenant: string | undefined;
    const job: SchedulerJob = {
      name: "g",
      scope: "global",
      async run(ctx: JobContext) {
        receivedTenant = ctx.tenantId;
        return {};
      },
    };
    const sch = createScheduler({
      jobs: [job],
      tickIntervalMs: 1_000_000,
      listTenants: async () => [{ id: "any" }],
    });
    await sch._tick();
    expect(receivedTenant).toBe("*");
  });
});
