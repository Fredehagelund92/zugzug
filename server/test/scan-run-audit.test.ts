process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { createScheduler, type SchedulerJob } from "../src/scheduler.ts";
import { pgAll } from "../src/pg.ts";

beforeEach(async () => {
  await resetDb();
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

test("scan_run — successful job writes one ok row with rows_scanned + duration", async () => {
  const scheduler = createScheduler({
    tickIntervalMs: 999_999,
    jobs: [makeJob("test-ok", async () => ({ rowsScanned: 7 }))],
  });
  await scheduler._tick();
  const rows = await listScanRuns();
  expect(rows).toHaveLength(1);
  expect(rows[0].source_id).toBe("test-ok");
  expect(rows[0].status).toBe("ok");
  expect(rows[0].rows_scanned).toBe(7);
  expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
  expect(rows[0].error_message).toBeNull();
  expect(rows[0].ended_at).not.toBeNull();
});

test("scan_run — failing job writes one error row with error_message", async () => {
  const scheduler = createScheduler({
    tickIntervalMs: 999_999,
    jobs: [makeJob("test-fail", async () => { throw new Error("boom"); })],
  });
  await scheduler._tick();
  const rows = await listScanRuns();
  expect(rows).toHaveLength(1);
  expect(rows[0].source_id).toBe("test-fail");
  expect(rows[0].status).toBe("error");
  expect(rows[0].error_message).toBe("boom");
  expect(rows[0].rows_scanned).toBeNull();
  expect(rows[0].ended_at).not.toBeNull();
});

test("scan_run — multiple jobs per tick produce one row each in order", async () => {
  const scheduler = createScheduler({
    tickIntervalMs: 999_999,
    jobs: [
      makeJob("alpha", async () => ({ rowsScanned: 1 })),
      makeJob("beta", async () => ({ rowsScanned: 2 })),
      makeJob("gamma", async () => ({ rowsScanned: 3 })),
    ],
  });
  await scheduler._tick();
  const rows = await listScanRuns();
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.source_id)).toEqual(["alpha", "beta", "gamma"]);
  expect(rows.every((r) => r.status === "ok")).toBe(true);
});

test("scan_run — failure in middle job doesn't prevent subsequent jobs from being recorded", async () => {
  const scheduler = createScheduler({
    tickIntervalMs: 999_999,
    jobs: [
      makeJob("first", async () => ({})),
      makeJob("crash", async () => { throw new Error("middle failure"); }),
      makeJob("last", async () => ({})),
    ],
  });
  await scheduler._tick();
  const rows = await listScanRuns();
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.status)).toEqual(["ok", "error", "ok"]);
});
