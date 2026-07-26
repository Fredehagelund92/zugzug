process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun } from "./pg.ts";
import { pgAll, cq } from "./repo-shared.ts";
import { addRefTable, listRefTables, deleteRefTable } from "./repo-record.ts";
import { saveDraft, commit } from "./repo-drafts.ts";
import { getSourceScanScalars } from "./repo-source-scan.ts";

async function seedScanValue(refTableId: string, raw: string, rows: number): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."source_scan_value"
       (tenant_id, reference_table_id, raw, raw_lower, total_rows, scanned_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id, reference_table_id, raw_lower) DO NOTHING`,
    [T, refTableId, raw, raw.toLowerCase(), rows],
  );
}

const T = "test_list_reftbl";
const U = "u_list_reftbl";

async function dropDims(): Promise<void> {
  const refTables = await pgAll<{ id: string }>(
    `SELECT id FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`,
    [T],
  ).catch(() => [] as { id: string }[]);
  for (const d of refTables) await deleteRefTable(d.id, "test-teardown", T).catch(() => {});
}

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'ListRefTbl', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'List RefTable', 'lrt@example.test', 'LR', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await dropDims();
  await pgRun(`DELETE FROM "zugzug_app"."source_scan_value" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

// #153: listRefTables folded the N+1 per-table map_<table> COUNT into one
// UNION ALL round-trip. Each table's `rows` must still equal its own map count.
describe("listRefTables row counts (#153)", () => {
  it("returns the correct per-table map count across multiple tables", async () => {
    const a = await addRefTable("CountA", [], { keyKind: "slug" }, U, T);
    const b = await addRefTable("CountB", [], { keyKind: "slug" }, U, T);
    const c = await addRefTable("CountC_empty", [], { keyKind: "slug" }, U, T);

    // A gets 2 mapped values, B gets 1, C stays empty.
    await saveDraft(a, "usa", "mapped", "United States", "united_states", U, T);
    await saveDraft(a, "u.s.", "mapped", "United States", "united_states2", U, T);
    await commit(a, U, T);
    await saveDraft(b, "germany", "mapped", "Germany", "germany", U, T);
    await commit(b, U, T);

    const tables = await listRefTables(T);
    const byId = Object.fromEntries(tables.map((t) => [t.id, t.rows]));
    expect(byId[a]).toBe(2);
    expect(byId[b]).toBe(1);
    expect(byId[c]).toBe(0);
  });

  it("falls back to per-table counts when a map_<table> is missing (#153)", async () => {
    const ok = await addRefTable("FallbackOK", [], { keyKind: "slug" }, U, T);
    const broken = await addRefTable("FallbackBroken", [], { keyKind: "slug" }, U, T);
    await saveDraft(ok, "usa", "mapped", "United States", "united_states", U, T);
    await commit(ok, U, T);

    // Drop one map table so the single UNION ALL fails and the resilient
    // per-table path takes over — the healthy table's count must still resolve.
    const [meta] = await pgAll<{ mapTable: string }>(
      `SELECT map_table AS "mapTable" FROM "zugzug_app"."reference_table" WHERE id = $1`,
      [broken],
    );
    await pgRun(`DROP TABLE IF EXISTS ${cq(meta.mapTable)}`);

    const tables = await listRefTables(T);
    const byId = Object.fromEntries(tables.map((t) => [t.id, t.rows]));
    expect(byId[ok]).toBe(1); // healthy table still counted via the fallback
    expect(byId[broken]).toBe(0); // missing table degrades to 0, doesn't throw
  });
});

// #153: getSourceScanScalars folded its per-table map join loop into one UNION ALL.
describe("getSourceScanScalars (#153)", () => {
  it("computes mapped/new counts per table from source_scan_value", async () => {
    const refTableId = await addRefTable("ScalarDim", [], { keyKind: "slug" }, U, T);
    // Publish one mapping so map_<id> contains raw "usa".
    await saveDraft(refTableId, "usa", "mapped", "United States", "united_states", U, T);
    await commit(refTableId, U, T);
    // Two scanned source values: "usa" is mapped, "france" is not.
    await seedScanValue(refTableId, "usa", 100);
    await seedScanValue(refTableId, "france", 40);

    const scalars = await getSourceScanScalars(T);
    const entry = scalars.find((s) => s.refTableId === refTableId);
    expect(entry).toBeDefined();
    expect(entry!.totalDistinct).toBe(2);
    expect(entry!.mappedCount).toBe(1);
    expect(entry!.newCount).toBe(1);
    expect(entry!.mappedRowsTotal).toBe(100);
    expect(entry!.unmappedRowsTotal).toBe(40);
  });
});
