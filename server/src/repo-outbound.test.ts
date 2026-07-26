process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.ZUGZUG_CURSOR_KEY =
  process.env.ZUGZUG_CURSOR_KEY || "lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8=";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import { addRefTable, mergeRecord, retireRecord } from "./repo-record.ts";

// Pull API requires both dim_* row + record_version row. The bulk `addRecord`
// helper only writes the former, so seed both directly to keep keys verbatim
// (addRecordOne lowercases via slug()).
async function addRecord(
  refTableId: string,
  values: { key: string; label: string }[],
  tenantId: string,
): Promise<void> {
  const meta = await pgGet<{ dim_table: string; key_col: string }>(
    `SELECT dim_table, key_col FROM "zugzug_app"."reference_table" WHERE id = $1 AND tenant_id = $2`,
    [refTableId, tenantId],
  );
  if (!meta) throw new Error(`addRecord: refTable ${refTableId} not found`);
  const [schema, table] = meta.dim_table.split(".");
  for (const v of values) {
    await pgRun(
      `INSERT INTO "${schema}"."${table}" ("${meta.key_col}", label) VALUES ($1, $2)
       ON CONFLICT ("${meta.key_col}") DO NOTHING`,
      [v.key, v.label],
    );
    await pgRun(
      `INSERT INTO "zugzug_app"."record_version" (reference_table_id, key, version, updated_at, updated_by, tenant_id)
       VALUES ($1, $2, 1, now(), $3, $4)
       ON CONFLICT (tenant_id, reference_table_id, key) DO UPDATE
         SET retired_at = NULL, retired_into = NULL,
             version = "record_version".version + 1,
             updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [refTableId, v.key, U, tenantId],
    );
  }
}
import {
  listRefTablesForApi,
  getSchemaForApi,
  listRecordPage,
  getRecordRow,
  listTombstonesPage,
} from "./repo-outbound.ts";

const T = "test_repo_outbound";
const U = "u_test_outbound";

// Track created refTable ids so we can DROP their dynamic tables in afterAll.
const createdDims: string[] = [];

async function makeDim(name: string, keyKind: "slug" | "external_id" = "slug"): Promise<string> {
  const id = await addRefTable(name, [], { keyKind, silent: true }, U, T);
  createdDims.push(id);
  return id;
}

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'Sweep', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Outbound Test', 'orb@example.test', 'OT', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  for (const id of createdDims) {
    await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${id}"`).catch(() => {});
    await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${id}"`).catch(() => {});
  }
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("listRefTablesForApi", () => {
  it("returns one entry per refTable with slug, label, key_kind, record_count, last_published_at", async () => {
    const refTableId = await makeDim("OutCountry");
    await addRecord(refTableId, [{ key: "DE", label: "Germany" }], T);

    const out = await listRefTablesForApi(T);
    const country = out.tables.find((d) => d.slug === refTableId);
    expect(country).toBeDefined();
    expect(country!.label).toBe("OutCountry");
    expect(country!.key_kind).toBe("slug");
    expect(country!.record_count).toBeGreaterThanOrEqual(1);
    expect(typeof country!.last_published_at).toBe("string");
  });

  // #153: the single GROUP BY join must match the old per-table correlated
  // subqueries — notably the LEFT JOIN's NULL rows for an empty table and the
  // retired-record exclusion.
  it("reports 0 record_count and null last_published_at for an empty table", async () => {
    const refTableId = await makeDim("OutEmpty153");
    const out = await listRefTablesForApi(T);
    const entry = out.tables.find((d) => d.slug === refTableId);
    expect(entry).toBeDefined();
    expect(entry!.record_count).toBe(0);
    expect(entry!.last_published_at).toBeNull();
  });

  it("excludes retired records from record_count", async () => {
    const refTableId = await makeDim("OutRetired153");
    await addRecord(
      refTableId,
      [
        { key: "LIVE", label: "Live" },
        { key: "DEAD", label: "Dead" },
      ],
      T,
    );
    const v = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."record_version"
       WHERE reference_table_id = $1 AND key = 'DEAD' AND tenant_id = $2`,
      [refTableId, T],
    );
    await retireRecord(refTableId, "DEAD", U, v!.version, T);

    const out = await listRefTablesForApi(T);
    const entry = out.tables.find((d) => d.slug === refTableId);
    expect(entry!.record_count).toBe(1); // only LIVE counted
  });
});

describe("getSchemaForApi", () => {
  it("returns dim_slug + fields", async () => {
    const refTableId = await makeDim("OutSchema");
    const out = await getSchemaForApi(T, refTableId);
    expect(out).not.toBeNull();
    expect(out!.dim_slug).toBe(refTableId);
    expect(out!.label).toBe("OutSchema");
    expect(Array.isArray(out!.fields)).toBe(true);
  });

  it("returns null when the refTable doesn't exist OR belongs to another tenant", async () => {
    expect(await getSchemaForApi(T, "no_such_dim")).toBeNull();
  });
});

describe("listRecordPage", () => {
  it("returns records in updated_at, key order; respects limit; emits a cursor on truncation", async () => {
    const refTableId = await makeDim("OutPage");
    await addRecord(
      refTableId,
      Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, label: `Label ${i}` })),
      T,
    );

    const page1 = await listRecordPage(T, refTableId, { limit: 3 });
    expect(page1.records.length).toBe(3);
    expect(page1.cursor.next).not.toBeNull();
    expect(page1.meta.dim_slug).toBe(refTableId);
    expect(page1.meta.page_size).toBe(3);

    const page2 = await listRecordPage(T, refTableId, { limit: 3, cursor: page1.cursor.next! });
    expect(page2.records.length).toBe(2);
    expect(page2.cursor.next).toBeNull();

    const allKeys = [...page1.records, ...page2.records].map((r) => r.key);
    expect(new Set(allKeys).size).toBe(5);
  });

  it("?since= filters by record_version.updated_at (inclusive)", async () => {
    const refTableId = await makeDim("OutSince");
    await addRecord(refTableId, [{ key: "OLD", label: "Old" }], T);

    const boundary = await pgGet<{ ts: string }>(
      `SELECT to_char(
         (now() + interval '100 milliseconds')::timestamp,
         'YYYY-MM-DD HH24:MI:SS.US'
       ) AS ts`,
    );
    await new Promise((r) => setTimeout(r, 250));

    await addRecord(refTableId, [{ key: "NEW", label: "New" }], T);

    const res = await listRecordPage(T, refTableId, { since: boundary!.ts, limit: 100 });
    const keys = res.records.map((r) => r.key);
    expect(keys).toContain("NEW");
    expect(keys).not.toContain("OLD");
  });

  it("excludes soft-deleted rows", async () => {
    const refTableId = await makeDim("OutSoftDel");
    await addRecord(
      refTableId,
      [
        { key: "A", label: "Alpha" },
        { key: "B", label: "Beta" },
      ],
      T,
    );
    const versions = await pgAll<{ key: string; version: number }>(
      `SELECT key, version FROM "zugzug_app"."record_version"
       WHERE reference_table_id = $1 AND tenant_id = $2`,
      [refTableId, T],
    );
    const v = Object.fromEntries(versions.map((r) => [r.key, r.version]));
    await mergeRecord(refTableId, "A", ["B"], U, v, T);

    const res = await listRecordPage(T, refTableId, { limit: 100 });
    expect(res.records.map((r) => r.key)).toEqual(["A"]);
  });

  it("returns 0 rows for a refTable that belongs to a different tenant", async () => {
    const refTableId = await makeDim("OutTenantScope");
    await addRecord(refTableId, [{ key: "X", label: "X" }], T);
    const res = await listRecordPage("other_tenant_id", refTableId, { limit: 100 });
    expect(res.records).toEqual([]);
  });
});

describe("getRecordRow", () => {
  it("returns the row for a live key", async () => {
    const refTableId = await makeDim("OutOne");
    await addRecord(refTableId, [{ key: "ONE", label: "One" }], T);
    const row = await getRecordRow(T, refTableId, "ONE");
    expect(row).not.toBeNull();
    expect(row!.key).toBe("ONE");
    expect(row!.label).toBe("One");
  });

  it("returns null for a retired key", async () => {
    const refTableId = await makeDim("OutRetired");
    await addRecord(refTableId, [{ key: "GONE", label: "Gone" }], T);
    const v = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."record_version"
       WHERE reference_table_id = $1 AND key = 'GONE' AND tenant_id = $2`,
      [refTableId, T],
    );
    await retireRecord(refTableId, "GONE", U, v!.version, T);
    expect(await getRecordRow(T, refTableId, "GONE")).toBeNull();
  });
});

describe("listTombstonesPage", () => {
  it("returns retired keys with retired_at + retired_into", async () => {
    const refTableId = await makeDim("OutTombs");
    await addRecord(
      refTableId,
      [
        { key: "SURV", label: "Survivor" },
        { key: "MERGED", label: "Merged" },
        { key: "RETIRED", label: "Retired" },
      ],
      T,
    );
    const versions = await pgAll<{ key: string; version: number }>(
      `SELECT key, version FROM "zugzug_app"."record_version"
       WHERE reference_table_id = $1 AND tenant_id = $2`,
      [refTableId, T],
    );
    const v = Object.fromEntries(versions.map((r) => [r.key, r.version]));
    await mergeRecord(refTableId, "SURV", ["MERGED"], U, v, T);
    await retireRecord(refTableId, "RETIRED", U, v.RETIRED, T);

    const res = await listTombstonesPage(T, refTableId, { limit: 100 });
    const byKey = Object.fromEntries(res.removed.map((t) => [t.key, t]));
    expect(byKey.MERGED).toBeDefined();
    expect(byKey.MERGED.retired_into).toBe("SURV");
    expect(byKey.RETIRED).toBeDefined();
    expect(byKey.RETIRED.retired_into).toBeNull();
  });
});
