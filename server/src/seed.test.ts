process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll } from "bun:test";
import { resetDb } from "../test/setup.ts";
import { pgGet } from "./pg.ts";
import { seedDemo } from "./seed.ts";

// Regression for #192. `bootstrap` runs `seedDemo` on every boot when
// SEED_DEMO=true, so it must be a no-op once the demo already exists. Re-running
// it re-did all its work — re-committing mappings and re-appending audit rows —
// and against a warehouse-backed deploy that redundant re-commit crashed the
// boot on a duplicate `map_<table>` key, crash-looping the server on redeploy.
async function count(table: string): Promise<number> {
  const row = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app".${table} WHERE tenant_id = 'default'`,
  );
  return row?.n ?? 0;
}

describe("seedDemo is a no-op once the demo is already seeded (#192)", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("does no further work on a second run", async () => {
    await seedDemo();
    const refTables = await count("reference_table");
    const audit = await count("audit_log");
    expect(refTables).toBeGreaterThan(0);
    expect(audit).toBeGreaterThan(0);

    // A second run mirrors a redeploy/reboot. It must not throw and must not
    // re-do work — reference tables and the audit trail stay put.
    await seedDemo();
    expect(await count("reference_table")).toBe(refTables);
    expect(await count("audit_log")).toBe(audit);
  });
});
