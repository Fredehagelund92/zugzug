/* scheduler-jobs.ts — concrete SchedulerJob instances for the per-tick pipeline.
   Each runs independently; failures don't cascade. The scheduler module's per-job
   try/catch means one job's error doesn't prevent subsequent jobs in the tick.

   Order matters: scan (writes source_stat) → auto-stage (reads them) → auto-commit
   (uses stage results). The scheduler runs jobs in array order. */

import type { SchedulerJob, JobResult } from "./scheduler.ts";
import { env } from "./env.ts";
import { scanSources, autoStageExactMatches, dimensionsWithWiredSources } from "./repo-scan.ts";
import { commit } from "./repo-drafts.ts";
import { getPreferences } from "./repo-meta.ts";

export const scanSourcesJob: SchedulerJob = {
  name: "scan-sources",
  async run(): Promise<JobResult> {
    const n = await scanSources();
    return { rowsScanned: n };
  },
};

export const autoStageJob: SchedulerJob = {
  name: "auto-stage-exact-matches",
  async run(): Promise<JobResult> {
    if (!env.attachWarehouse) return {};
    const dimIds = await dimensionsWithWiredSources();
    let totalStaged = 0;
    for (const id of dimIds) {
      const staged = await autoStageExactMatches(id);
      totalStaged += staged;
    }
    return { rowsScanned: totalStaged };
  },
};

export const autoCommitJob: SchedulerJob = {
  name: "auto-commit",
  async run(): Promise<JobResult> {
    if (!env.attachWarehouse) return {};
    const prefs = await getPreferences();
    if (prefs.publishThreshold > 100) return {}; // threshold disables auto-commit
    const dimIds = await dimensionsWithWiredSources();
    let totalCommitted = 0;
    for (const id of dimIds) {
      const result = await commit(id, "u_system");
      totalCommitted += result.committed;
    }
    return { rowsScanned: totalCommitted };
  },
};
