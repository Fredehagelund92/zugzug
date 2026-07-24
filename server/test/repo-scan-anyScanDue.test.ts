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
  // addSource() resolves database via warehouse_database; seed one for tests.
  await pgRun(
    `INSERT INTO zugzug_app.warehouse_database (id, database_name, added_at, added_by)
     VALUES ('whd_test', 'test_db', now(), 'u_system') ON CONFLICT DO NOTHING`,
  );
});

test("anyScanDue returns true when no sources are wired (lastScan is null)", async () => {
  // Insert preferences row only — no sources, no source_stat rows
  await pgRun(
    `INSERT INTO zugzug_app.preferences (id, scan_schedule, publish_threshold, suggest_threshold, updated_at, tenant_id)
     VALUES (1, 'hourly', 95, 75, current_timestamp, 'default')
     ON CONFLICT (id) DO UPDATE SET scan_schedule = 'hourly'`,
  );
  // anyScanDue returns true because lastScan is null (never scanned)
  expect(await anyScanDue(new Date())).toBe(true);
});

test("anyScanDue returns false when most-recent scan is within cadence window", async () => {
  // Setup: preferences + refTable + registered source + recent scan stat
  await pgRun(
    `INSERT INTO zugzug_app.preferences (id, scan_schedule, publish_threshold, suggest_threshold, updated_at, tenant_id)
     VALUES (1, 'hourly', 95, 75, current_timestamp, 'default')
     ON CONFLICT (id) DO UPDATE SET scan_schedule = 'hourly'`,
  );

  const userId = "u_test";
  const refTableId = await repo.addRefTable("Partner", [], { keyKind: "slug" }, userId, "default");

  // Register a source
  await addSource(refTableId, "public.partners", "partner_id", "default");

  // Insert a source_stat row scanned 10 minutes ago (within hourly window)
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
  await pgRun(
    `INSERT INTO zugzug_app.source_stat
       (reference_table_id, database_id, schema_name, table_name, column_name, present, rows, distinct_values, unmapped, scanned_at, tenant_id)
     VALUES ($1, 'whd_test', 'public', 'partners', 'partner_id', true, 100, 50, 5, $2, 'default')
     ON CONFLICT (tenant_id, reference_table_id, database_id, schema_name, table_name, column_name) DO UPDATE SET
       present = EXCLUDED.present, rows = EXCLUDED.rows,
       distinct_values = EXCLUDED.distinct_values, unmapped = EXCLUDED.unmapped,
       scanned_at = EXCLUDED.scanned_at`,
    [refTableId, tenMinutesAgo],
  );

  // anyScanDue returns false (most recent scan is 10 min ago, within hourly window)
  expect(await anyScanDue(new Date())).toBe(false);
});

test("anyScanDue returns true when a newly-registered source has never been scanned (THE BUG)", async () => {
  // Setup: preferences + one refTable with TWO sources
  await pgRun(
    `INSERT INTO zugzug_app.preferences (id, scan_schedule, publish_threshold, suggest_threshold, updated_at, tenant_id)
     VALUES (1, 'hourly', 95, 75, current_timestamp, 'default')
     ON CONFLICT (id) DO UPDATE SET scan_schedule = 'hourly'`,
  );

  const userId = "u_test";
  const refTableId = await repo.addRefTable("Partner", [], { keyKind: "slug" }, userId, "default");

  // Register TWO sources
  await addSource(refTableId, "public.partners", "partner_id", "default");
  await addSource(refTableId, "public.accounts", "account_id", "default");

  // Only the FIRST source has been scanned (10 min ago, within hourly window)
  // The SECOND source has never been scanned (no source_stat row)
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
  await pgRun(
    `INSERT INTO zugzug_app.source_stat
       (reference_table_id, database_id, schema_name, table_name, column_name, present, rows, distinct_values, unmapped, scanned_at, tenant_id)
     VALUES ($1, 'whd_test', 'public', 'partners', 'partner_id', true, 100, 50, 5, $2, 'default')`,
    [refTableId, tenMinutesAgo],
  );

  // With the bug: anyScanDue returns false (MAX(scanned_at) is 10 min ago, within window)
  // With the fix: anyScanDue returns true (unscanned_count > 0 — the accounts.account_id source)
  expect(await anyScanDue(new Date())).toBe(true);
});
