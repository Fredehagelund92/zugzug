/* scheduler.ts — generic tick scheduler with in-flight guard and clean stop().
   Extracted from the inline block that was in server.ts.

   PR2b (multi-tenant): each tick iterates every active tenant; for each tenant
   the scheduler opens a pgTxScoped tx (SET LOCAL app.tenant_id) and constructs
   a TenantRepo with role=admin/isSuperAdmin=true that's passed to every job
   via ctx.repo. shouldRun(tenantId) gates per-tenant.

   NOTE: pgTxScoped's SET LOCAL is currently belt-and-suspenders for the future
   RLS rollout (PR5). TenantRepo's forwarders pull a fresh pool connection per
   call rather than reusing the in-tx connection — that mismatch is acceptable
   in PR2b because the tenant_id filter lives in the SQL WHERE clauses; PR5 will
   tighten this when RLS lands. */

import { pgAll, pgRun, pgTxScoped } from "./pg.ts";
import { pg } from "./env.ts";
import { captureError } from "./observability.ts";
import { appendAuditAs } from "./repo-meta.ts";
import type { TenantRepo } from "./tenant-repo.ts";

export interface SchedulerJob {
  /** Stable name for logging + scan_run.source_id; e.g., "scan-sources" */
  name: string;
  /** "global" jobs run once per tick across all tenants — they do their own
   *  cross-tenant claims. Default "per-tenant": iterated once per active tenant. */
  scope?: "per-tenant" | "global";
  /** Per-job gate, checked once per tenant per tick. Default: run. Each job
   *  owns its own condition — a tenant with scans switched off must not also
   *  stop auto-matching and auto-publishing. */
  shouldRun?(ctx: JobContext): Promise<boolean>;
  /** Returns rowsScanned-ish metadata (or empty object). Throws on hard failure. */
  run(ctx: JobContext): Promise<JobResult>;
}

export interface JobContext {
  signal: AbortSignal; // honored later by Task A8 graceful shutdown
  tenantId: string;
  repo: TenantRepo;
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

async function recordScanRun(
  jobName: string,
  tenantId: string,
  fn: () => Promise<JobResult>,
  stopped: () => boolean,
): Promise<void> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "")}`;
  const startedAt = new Date();
  try {
    await pgRun(
      `INSERT INTO ${pg("scan_run")} (id, source_id, started_at, status, tenant_id)
       VALUES ($1, $2, $3, 'running', $4)`,
      [runId, jobName, startedAt, tenantId],
    );
  } catch (e) {
    // Don't let scan_run persistence failure block the job — log and proceed.
    console.error(`scheduler: scan_run INSERT failed for ${jobName}:`, e);
    await fn().catch((jobErr) => {
      console.error(`scheduler job '${jobName}' failed:`, jobErr);
      captureError(jobErr, { job: jobName });
    });
    return;
  }

  try {
    const result = await fn();
    // Skip DB writes if the scheduler was stopped while the job was running —
    // prevents open transactions from racing with resetDb() in tests, and
    // avoids unnecessary DB writes after a graceful shutdown.
    if (stopped()) return;
    const durationMs = Date.now() - startedAt.getTime();
    await pgRun(
      `UPDATE ${pg("scan_run")} SET ended_at = $1, status = 'ok',
        rows_scanned = $2, duration_ms = $3 WHERE id = $4`,
      [new Date(), result.rowsScanned ?? null, durationMs, runId],
    ).catch((e) => console.error(`scheduler: scan_run UPDATE failed for ${runId}:`, e));
  } catch (jobErr) {
    if (stopped()) return;
    const durationMs = Date.now() - startedAt.getTime();
    const errorMessage = jobErr instanceof Error ? jobErr.message : String(jobErr);
    await pgRun(
      `UPDATE ${pg("scan_run")} SET ended_at = $1, status = 'error',
        error_message = $2, duration_ms = $3 WHERE id = $4`,
      [new Date(), errorMessage, durationMs, runId],
    ).catch((e) => console.error(`scheduler: scan_run UPDATE failed for ${runId}:`, e));
    // Fire-and-forget: surface failure in the audit feed without blocking the scheduler.
    appendAuditAs("u_system", "scan_failed", `${jobName} — ${errorMessage} (run: ${runId})`, {
      tenantId,
    }).catch((e) => console.error(`scheduler: audit emission failed for ${runId}:`, e));
    console.error(`scheduler job '${jobName}' failed:`, jobErr);
    captureError(jobErr, { job: jobName });
  }
}

async function defaultListTenants(): Promise<Array<{ id: string }>> {
  return pgAll<{ id: string }>(
    `SELECT id FROM ${pg("tenant")} WHERE deleted_at IS NULL ORDER BY id`,
  );
}

export interface CreateSchedulerOpts {
  tickIntervalMs: number;
  jobs: SchedulerJob[];
  /** Per-tenant gate: called once per tenant per tick, before any job runs.
   *  Default: always run — individual jobs gate themselves via
   *  SchedulerJob.shouldRun. */
  shouldRun?: (tenantId: string) => Promise<boolean>;
  /** Returns the tenants to iterate this tick. Default: SELECT id FROM tenant WHERE deleted_at IS NULL. */
  listTenants?: () => Promise<Array<{ id: string }>>;
}

export function createScheduler(opts: CreateSchedulerOpts): Scheduler {
  const { tickIntervalMs, jobs, shouldRun } = opts;
  const listTenants = opts.listTenants ?? defaultListTenants;

  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;
  // Resolves the "drain" promise when the in-flight tick finishes.
  let drainResolve: (() => void) | null = null;
  let drainPromise: Promise<void> | null = null;
  let abortController = new AbortController();
  let lastTickActual: number | null = null;
  // Set by stop() after the drain window so a zombie in-flight tick skips
  // further tenants and DB writes when it eventually resumes.
  let stopped = false;

  async function _tick(): Promise<void> {
    const tickStart = Date.now();

    if (tickInFlight) {
      console.error(
        `scheduler: tick skipped — previous tick still running after ${tickIntervalMs}ms`,
      );
      return;
    }

    // Track drift: actual tick time vs expected interval
    if (lastTickActual !== null) {
      const drift = tickStart - lastTickActual - tickIntervalMs;
      if (drift > tickIntervalMs / 2) {
        console.warn(
          `scheduler: tick drifted by ${drift}ms (expected ${tickIntervalMs}ms; actual ${tickStart - lastTickActual}ms)`,
        );
      }
    }
    lastTickActual = tickStart;
    tickInFlight = true; // set synchronously before any awaits

    // Set up drain tracking
    drainPromise = new Promise<void>((resolve) => {
      drainResolve = resolve;
    });

    try {
      // Lazy import to dodge any circular module load between scheduler.ts and
      // tenant-repo.ts → repo-* modules.
      const { TenantRepo } = await import("./tenant-repo.ts");

      // Phase 1: global jobs run once per tick with a dummy context (tenantId="*").
      // Used by jobs that do their own cross-tenant claim (e.g. webhook dispatcher
      // SKIP LOCKED across all tenants in a single query).
      for (const job of jobs) {
        if (job.scope !== "global") continue;
        if (stopped) break;
        const ctx: JobContext = {
          signal: abortController.signal,
          tenantId: "*",
          repo: {} as TenantRepo,
        };
        await recordScanRun(
          job.name,
          "*",
          () => job.run(ctx),
          () => stopped,
        );
      }

      let tenants: Array<{ id: string }>;
      try {
        tenants = await listTenants();
      } catch (e) {
        console.error("· scheduler: listTenants failed:", e);
        return;
      }

      for (const t of tenants) {
        if (stopped) break;
        if (shouldRun !== undefined) {
          let due: boolean;
          try {
            due = await shouldRun(t.id);
          } catch (e) {
            console.error(`· scheduler: shouldRun(${t.id}) check failed:`, e);
            continue;
          }
          if (!due) continue;
        }

        try {
          await pgTxScoped(t.id, async () => {
            const repo = new TenantRepo(t.id, "admin", true);
            const ctx: JobContext = {
              signal: abortController.signal,
              tenantId: t.id,
              repo,
            };
            for (const job of jobs) {
              if (job.scope === "global") continue;
              if (job.shouldRun !== undefined) {
                let due: boolean;
                try {
                  due = await job.shouldRun(ctx);
                } catch (e) {
                  console.error(`· scheduler: ${job.name}.shouldRun(${t.id}) failed:`, e);
                  continue;
                }
                if (!due) continue;
              }
              await recordScanRun(
                `${t.id}:${job.name}`,
                t.id,
                () => job.run(ctx),
                () => stopped,
              );
            }
          });
        } catch (e) {
          console.error(`· scheduler: tenant '${t.id}' tick failed:`, e);
        }
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
    stopped = false; // clear any previous stop() so ticks resume DB writes
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

    // Hard-stop: if the drain timed out, an in-flight tick may still be running.
    // Setting `stopped` here (after the drain window) makes that zombie tick skip
    // any further tenants and DB writes when it eventually resumes, so it cannot
    // collide with whatever runs after stop() returns. Jobs that finished within
    // the drain window were recorded normally. stopped stays true until start().
    stopped = true;
    // Reset abort controller for potential re-use.
    abortController = new AbortController();
  }

  return { start, stop, _tick };
}
