/* scheduler.ts — generic tick scheduler with in-flight guard and clean stop().
   Extracted from the inline block that was in server.ts. */

import { pgRun } from "./pg.ts";
import { pg } from "./env.ts";

export interface SchedulerJob {
  /** Stable name for logging + scan_run.source_id; e.g., "scan-sources" */
  name: string;
  /** Returns rowsScanned-ish metadata (or empty object). Throws on hard failure. */
  run(ctx: JobContext): Promise<JobResult>;
}

export interface JobContext {
  signal: AbortSignal; // honored later by Task A8 graceful shutdown
}

export interface JobResult {
  rowsScanned?: number;
}

export interface Scheduler {
  start(): void;
  stop(drainTimeoutMs?: number): Promise<void>;
  /** Test hook: trigger one tick synchronously without waiting for the interval. */
  _tick(): Promise<void>;
}

async function recordScanRun(jobName: string, fn: () => Promise<JobResult>): Promise<void> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "")}`;
  const startedAt = new Date();
  try {
    await pgRun(
      `INSERT INTO ${pg("scan_run")} (id, source_id, started_at, status)
       VALUES ($1, $2, $3, 'running')`,
      [runId, jobName, startedAt],
    );
  } catch (e) {
    // Don't let scan_run persistence failure block the job — log and proceed.
    console.error(`scheduler: scan_run INSERT failed for ${jobName}:`, e);
    await fn().catch((jobErr) => {
      console.error(`scheduler job '${jobName}' failed:`, jobErr);
    });
    return;
  }

  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt.getTime();
    await pgRun(
      `UPDATE ${pg("scan_run")} SET ended_at = $1, status = 'ok',
        rows_scanned = $2, duration_ms = $3 WHERE id = $4`,
      [new Date(), result.rowsScanned ?? null, durationMs, runId],
    ).catch((e) => console.error(`scheduler: scan_run UPDATE failed for ${runId}:`, e));
  } catch (jobErr) {
    const durationMs = Date.now() - startedAt.getTime();
    const errorMessage = jobErr instanceof Error ? jobErr.message : String(jobErr);
    await pgRun(
      `UPDATE ${pg("scan_run")} SET ended_at = $1, status = 'error',
        error_message = $2, duration_ms = $3 WHERE id = $4`,
      [new Date(), errorMessage, durationMs, runId],
    ).catch((e) => console.error(`scheduler: scan_run UPDATE failed for ${runId}:`, e));
    console.error(`scheduler job '${jobName}' failed:`, jobErr);
  }
}

export function createScheduler(opts: {
  tickIntervalMs: number;
  jobs: SchedulerJob[];
  /** Called when a job tick should be skipped (e.g., not due). Default: always run. */
  shouldRun?: () => Promise<boolean>;
}): Scheduler {
  const { tickIntervalMs, jobs, shouldRun } = opts;

  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;
  // Resolves the "drain" promise when the in-flight tick finishes.
  let drainResolve: (() => void) | null = null;
  let drainPromise: Promise<void> | null = null;
  let abortController = new AbortController();

  async function _tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true; // set synchronously before any awaits

    // Set up drain tracking
    drainPromise = new Promise<void>((resolve) => {
      drainResolve = resolve;
    });

    try {
      if (shouldRun !== undefined) {
        let due: boolean;
        try {
          due = await shouldRun();
        } catch (e) {
          console.error("· scheduler: shouldRun check failed:", e);
          return;
        }
        if (!due) return;
      }

      const ctx: JobContext = { signal: abortController.signal };
      for (const job of jobs) {
        await recordScanRun(job.name, () => job.run(ctx));
      }
    } finally {
      tickInFlight = false;
      drainResolve?.();
      drainResolve = null;
      drainPromise = null;
    }
  }

  function fireTick(): void {
    void _tick();
  }

  function start(): void {
    if (intervalHandle !== null) return; // idempotent
    fireTick(); // fire immediately, then on interval
    intervalHandle = setInterval(fireTick, tickIntervalMs);
  }

  async function stop(drainTimeoutMs = 30_000): Promise<void> {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    abortController.abort();

    if (drainPromise !== null) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs));
      await Promise.race([drainPromise, timeout]);
    }

    // Reset abort controller for potential re-use
    abortController = new AbortController();
  }

  return { start, stop, _tick };
}
