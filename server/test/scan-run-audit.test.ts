process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, spyOn } from "bun:test";
import { resetDb } from "./setup.ts";
import { createScheduler, type SchedulerJob } from "../src/scheduler.ts";
import { pgAll } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";

const T_ID = "tscanrun";

beforeEach(async () => {
  await resetDb();
  await provisionTenant({ id: T_ID, label: "ScanRun" });
});

interface ScanRunRow {
  id: string;
  source_id: string;
  status: string;
  rows_scanned: number | null;
  duration_ms: number | null;
  error_message: string | null;
  ended_at: string | null;
}

async function listScanRuns(): Promise<ScanRunRow[]> {
  return pgAll<ScanRunRow>(
    `SELECT id, source_id, status, rows_scanned, duration_ms, error_message, ended_at::text
     FROM zugzug_app.scan_run ORDER BY started_at ASC`,
  );
}

function makeJob(name: string, run: () => Promise<{ rowsScanned?: number }> = async () => ({})): SchedulerJob {
  return { name, run };
}

// Scheduler now iterates tenants per tick and prefixes scan_run.source_id with
// `${tenantId}:`. Tests force a single-tenant universe via listTenants so the
// expected source_id is deterministic.
const SINGLE_TENANT = { listTenants: async () => [{ id: T_ID }] };

test("scan_run — successful job writes one ok row with rows_scanned + duration", async () => {
  const scheduler = createScheduler({
    tickIntervalMs: 999_999,
    ...SINGLE_TENANT,
    jobs: [makeJob("test-ok", async () => ({ rowsScanned: 7 }))],
  });
  await scheduler._tick();
  const rows = await listScanRuns();
  expect(rows).toHaveLength(1);
  expect(rows[0].source_id).toBe(`${T_ID}:test-ok`);
  expect(rows[0].status).toBe("ok");
  expect(rows[0].rows_scanned).toBe(7);
  expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
  expect(rows[0].error_message).toBeNull();
  expect(rows[0].ended_at).not.toBeNull();
});

test("scan_run — failing job writes one error row with error_message", async () => {
  const scheduler = createScheduler({
    tickIntervalMs: 999_999,
    ...SINGLE_TENANT,
    jobs: [makeJob("test-fail", async () => { throw new Error("boom"); })],
  });
  await scheduler._tick();
  const rows = await listScanRuns();
  expect(rows).toHaveLength(1);
  expect(rows[0].source_id).toBe(`${T_ID}:test-fail`);
  expect(rows[0].status).toBe("error");
  expect(rows[0].error_message).toBe("boom");
  expect(rows[0].rows_scanned).toBeNull();
  expect(rows[0].ended_at).not.toBeNull();
});

test("scan_run — multiple jobs per tick produce one row each in order", async () => {
  const scheduler = createScheduler({
    tickIntervalMs: 999_999,
    ...SINGLE_TENANT,
    jobs: [
      makeJob("alpha", async () => ({ rowsScanned: 1 })),
      makeJob("beta", async () => ({ rowsScanned: 2 })),
      makeJob("gamma", async () => ({ rowsScanned: 3 })),
    ],
  });
  await scheduler._tick();
  const rows = await listScanRuns();
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.source_id)).toEqual([
    `${T_ID}:alpha`,
    `${T_ID}:beta`,
    `${T_ID}:gamma`,
  ]);
  expect(rows.every((r) => r.status === "ok")).toBe(true);
});

test("scan_run — failure in middle job doesn't prevent subsequent jobs from being recorded", async () => {
  // Silence the scheduler's expected error log so the suite stays quiet on
  // green. We assert below that the log fired with the expected payload, so
  // a future refactor that drops the log surfaces here.
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const scheduler = createScheduler({
      tickIntervalMs: 999_999,
      ...SINGLE_TENANT,
      jobs: [
        makeJob("first", async () => ({})),
        makeJob("crash", async () => {
          throw new Error("middle failure");
        }),
        makeJob("last", async () => ({})),
      ],
    });
    await scheduler._tick();
    const rows = await listScanRuns();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.status)).toEqual(["ok", "error", "ok"]);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(`scheduler job '${T_ID}:crash' failed`),
      expect.any(Error),
    );
  } finally {
    errSpy.mockRestore();
  }
});

test("scan failure emits scan_failed audit log entry", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const scheduler = createScheduler({
      tickIntervalMs: 999_999,
      ...SINGLE_TENANT,
      jobs: [
        makeJob("test-fail-audit", async () => {
          throw new Error("boom");
        }),
      ],
    });
    await scheduler._tick();
    // Fire-and-forget audit emission needs a moment to settle.
    await new Promise((r) => setTimeout(r, 50));
    const audits = await pgAll<{ action: string; detail: string }>(
      `SELECT action, detail FROM zugzug_app.audit_log WHERE action = 'scan_failed'`,
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const found = audits.some(
      (a) => a.detail.includes("test-fail-audit") && a.detail.includes("boom"),
    );
    expect(found).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  } finally {
    errSpy.mockRestore();
  }
});
