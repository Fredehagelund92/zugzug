/* scheduler-jobs.ts — concrete SchedulerJob instances for the per-tick pipeline.
   Each runs independently; failures don't cascade. The scheduler module's per-job
   try/catch means one job's error doesn't prevent subsequent jobs in the tick.

   Order matters: scan (writes source_stat) → auto-stage (reads them) → auto-commit
   (uses stage results). The scheduler runs jobs in array order.

   Each job carries its own gate (SchedulerJob.shouldRun): the scan cadence
   gates the scan, auto-publish preferences gate auto-commit. They are not
   chained — scans "Off" still leaves auto-matching and auto-publishing on.

   PR2b: jobs are tenant-scoped via ctx.repo (a TenantRepo bound to ctx.tenantId);
   the scheduler iterates tenants and constructs the repo. */

import type { SchedulerJob, JobResult, JobContext } from "./scheduler.ts";
import { env } from "./env.ts";
import { webhookDispatcherJob } from "./webhook-dispatcher.ts";
import { outboundRetentionSweepJob } from "./outbound-retention-sweep.ts";

export const scanSourcesJob: SchedulerJob = {
  name: "scan-sources",
  // The scan cadence gates the scan and nothing else. It used to gate the whole
  // tenant tick, so switching scans to "Off" silently stopped auto-matching and
  // auto-publishing too.
  shouldRun(ctx: JobContext): Promise<boolean> {
    return ctx.repo.anyScanDue(new Date());
  },
  async run(ctx: JobContext): Promise<JobResult> {
    const n = await ctx.repo.scanSources();
    return { rowsScanned: n };
  },
};

export const autoStageJob: SchedulerJob = {
  name: "auto-stage-exact-matches",
  async run(ctx: JobContext): Promise<JobResult> {
    if (!env.attachWarehouse) return {};
    const refTableIds = await ctx.repo.refTablesWithWiredSources();
    let totalStaged = 0;
    for (const id of refTableIds) {
      const { matched } = await ctx.repo.autoStageExactMatches(id);
      totalStaged += matched;
    }
    return { rowsScanned: totalStaged };
  },
};

export const autoCommitJob: SchedulerJob = {
  name: "auto-commit",
  async run(ctx: JobContext): Promise<JobResult> {
    if (!env.attachWarehouse) return {};
    const prefs = await ctx.repo.getPreferences();
    if (!prefs.autoPublishEnabled) return {}; // off unless the workspace opted in
    const refTableIds = await ctx.repo.refTablesWithWiredSources();
    let totalCommitted = 0;
    for (const id of refTableIds) {
      // onlyAuthor: fold nothing but the exact-match drafts autoStageJob wrote.
      // A teammate's draft always needs a human to publish it.
      const result = await ctx.repo.commit(id, "u_system", undefined, { onlyAuthor: "u_system" });
      totalCommitted += result.committed;
    }
    return { rowsScanned: totalCommitted };
  },
};

/** Build the scheduler's job list. Webhook dispatcher + retention sweep
 *  opt in via WEBHOOKS_ENABLED=1. */
export function buildJobs(): SchedulerJob[] {
  const jobs: SchedulerJob[] = [scanSourcesJob, autoStageJob, autoCommitJob];
  if (env.webhooksEnabled) {
    jobs.push(webhookDispatcherJob);
    jobs.push(outboundRetentionSweepJob);
  }
  return jobs;
}
