/* outbound-retention-sweep.ts — per-tenant scheduler job that deletes
   outbound_event + webhook_delivery rows older than 30 days, clears
   expired previous-secret material, and stamps preferences.last_outbound_sweep_at.

   Throttle: runs at most every 6 hours per tenant via last_outbound_sweep_at
   short-circuit. */

import type { SchedulerJob, JobContext, JobResult } from "./scheduler.ts";
import { pg } from "./env.ts";
import { pgRun, pgGet } from "./pg.ts";

const SWEEP_INTERVAL_HOURS = 6;
const RETENTION_DAYS = 30;

export const outboundRetentionSweepJob: SchedulerJob = {
  name: "outbound-retention-sweep",
  async run(ctx: JobContext): Promise<JobResult> {
    const tenantId = ctx.tenantId;

    // Throttle: check last sweep time using server-side arithmetic so that
    // TIMESTAMP-without-time-zone storage doesn't drift across JS/Postgres.
    const pref = await pgGet<{ throttled: boolean }>(
      `SELECT (last_outbound_sweep_at IS NOT NULL
              AND last_outbound_sweep_at > now() - interval '${SWEEP_INTERVAL_HOURS} hours') AS throttled
         FROM ${pg("preferences")} WHERE tenant_id = $1`,
      [tenantId],
    );
    if (pref?.throttled) {
      return { rowsScanned: 0 };
    }

    let total = 0;

    // 1. Delete old outbound_event rows.
    const evtResult = await pgGet<{ n: number }>(
      `WITH d AS (
         DELETE FROM ${pg("outbound_event")}
          WHERE tenant_id = $1 AND occurred_at < now() - interval '${RETENTION_DAYS} days'
          RETURNING 1
       ) SELECT count(*)::int AS n FROM d`,
      [tenantId],
    );
    total += evtResult?.n ?? 0;

    // 2. Delete old webhook_delivery rows.
    const delivResult = await pgGet<{ n: number }>(
      `WITH d AS (
         DELETE FROM ${pg("webhook_delivery")}
          WHERE tenant_id = $1 AND created_at < now() - interval '${RETENTION_DAYS} days'
          RETURNING 1
       ) SELECT count(*)::int AS n FROM d`,
      [tenantId],
    );
    total += delivResult?.n ?? 0;

    // 3. Clear expired previous secrets.
    await pgRun(
      `UPDATE ${pg("webhook")}
          SET secret_ciphertext_previous = NULL,
              secret_nonce_previous = NULL,
              secret_prefix_previous = NULL,
              secret_previous_expires_at = NULL
        WHERE tenant_id = $1
          AND secret_previous_expires_at IS NOT NULL
          AND secret_previous_expires_at < now()`,
      [tenantId],
    );

    // 4. Stamp last sweep.
    await pgRun(
      `UPDATE ${pg("preferences")}
          SET last_outbound_sweep_at = now(), updated_at = now()
        WHERE tenant_id = $1`,
      [tenantId],
    );

    return { rowsScanned: total };
  },
};
