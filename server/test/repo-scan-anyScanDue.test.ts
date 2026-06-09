// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { anyScanDue, addSource } from "../src/repo-scan.ts";
import { pgRun } from "../src/pg.ts";
import * as repo from "../src/repo.ts";

beforeEach(async () => {
  await resetDb();
});

test("anyScanDue returns true when no sources are wired (lastScan is null)", async () => {
  // Insert preferences row only — no sources, no source_stat rows
  await pgRun(
    `INSERT INTO zugzug_app.preferences (id, scan_schedule, publish_threshold, suggest_threshold, updated_at)
     VALUES (1, 'hourly', 95, 75, current_timestamp)
     ON CONFLICT (id) DO UPDATE SET scan_schedule = 'hourly'`,
  );
  // anyScanDue returns true because lastScan is null (never scanned)
  expect(await anyScanDue(new Date())).toBe(true);
});

test("anyScanDue returns false when most-recent scan is within cadence window", async () => {
  // Setup: preferences + dimension + registered source + recent scan stat
  await pgRun(
    `INSERT INTO zugzug_app.preferences (id, scan_schedule, publish_threshold, suggest_threshold, updated_at)
     VALUES (1, 'hourly', 95, 75, current_timestamp)
     ON CONFLICT (id) DO UPDATE SET scan_schedule = 'hourly'`,
  );

  const userId = "u_test";
  const dimId = await repo.addDimension("Partner", [], { keyKind: "slug" }, userId);

  // Register a source
  await addSource(dimId, "public.partners", "partner_id");

  // Insert a source_stat row scanned 10 minutes ago (within hourly window)
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
  await pgRun(
    `INSERT INTO zugzug_app.source_stat
       (dim_id, source_table, source_column, present, rows, distinct_values, unmapped, scanned_at)
     VALUES ($1, $2, $3, true, 100, 50, 5, $4)
     ON CONFLICT (dim_id, source_table, source_column) DO UPDATE SET
       present = EXCLUDED.present, rows = EXCLUDED.rows,
       distinct_values = EXCLUDED.distinct_values, unmapped = EXCLUDED.unmapped,
       scanned_at = EXCLUDED.scanned_at`,
    [dimId, "public.partners", "partner_id", tenMinutesAgo],
  );

  // anyScanDue returns false (most recent scan is 10 min ago, within hourly window)
  expect(await anyScanDue(new Date())).toBe(false);
});

test("anyScanDue returns true when a newly-registered source has never been scanned (THE BUG)", async () => {
  // Setup: preferences + one dimension with TWO sources
  await pgRun(
    `INSERT INTO zugzug_app.preferences (id, scan_schedule, publish_threshold, suggest_threshold, updated_at)
     VALUES (1, 'hourly', 95, 75, current_timestamp)
     ON CONFLICT (id) DO UPDATE SET scan_schedule = 'hourly'`,
  );

  const userId = "u_test";
  const dimId = await repo.addDimension("Partner", [], { keyKind: "slug" }, userId);

  // Register TWO sources
  await addSource(dimId, "public.partners", "partner_id");
  await addSource(dimId, "public.accounts", "account_id");

  // Only the FIRST source has been scanned (10 min ago, within hourly window)
  // The SECOND source has never been scanned (no source_stat row)
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
  await pgRun(
    `INSERT INTO zugzug_app.source_stat
       (dim_id, source_table, source_column, present, rows, distinct_values, unmapped, scanned_at)
     VALUES ($1, $2, $3, true, 100, 50, 5, $4)`,
    [dimId, "public.partners", "partner_id", tenMinutesAgo],
  );

  // With the bug: anyScanDue returns false (MAX(scanned_at) is 10 min ago, within window)
  // With the fix: anyScanDue returns true (unscanned_count > 0 — the accounts.account_id source)
  expect(await anyScanDue(new Date())).toBe(true);
});
