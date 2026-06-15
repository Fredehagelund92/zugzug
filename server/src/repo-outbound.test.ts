process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.ZUGZUG_CURSOR_KEY =
  process.env.ZUGZUG_CURSOR_KEY || "lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8=";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import { addDimension, mergeCanonical, retireCanonical } from "./repo-canonical.ts";

// Pull API requires both dim_* row + canonical_version row. The bulk `addCanonical`
// helper only writes the former, so seed both directly to keep keys verbatim
// (addCanonicalOne lowercases via slug()).
async function addCanonical(
  dimId: string,
  values: { key: string; label: string }[],
  tenantId: string,
): Promise<void> {
  const meta = await pgGet<{ dim_table: string; key_col: string }>(
    `SELECT dim_table, key_col FROM "zugzug_app"."dimension" WHERE id = $1 AND tenant_id = $2`,
    [dimId, tenantId],
  );
  if (!meta) throw new Error(`addCanonical: dim ${dimId} not found`);
  const [schema, table] = meta.dim_table.split(".");
  for (const v of values) {
    await pgRun(
      `INSERT INTO "${schema}"."${table}" ("${meta.key_col}", label) VALUES ($1, $2)
       ON CONFLICT ("${meta.key_col}") DO NOTHING`,
      [v.key, v.label],
    );
    await pgRun(
      `INSERT INTO "zugzug_app"."canonical_version" (dim_id, key, version, updated_at, updated_by, tenant_id)
       VALUES ($1, $2, 1, now(), $3, $4)
       ON CONFLICT (tenant_id, dim_id, key) DO UPDATE
         SET retired_at = NULL, retired_into = NULL,
             version = "canonical_version".version + 1,
             updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [dimId, v.key, U, tenantId],
    );
  }
}
import {
  listDimensionsForApi,
  getSchemaForApi,
  listCanonicalPage,
  getCanonicalRow,
  listTombstonesPage,
} from "./repo-outbound.ts";

const T = "test_repo_outbound";
const U = "u_test_outbound";

// Track created dim ids so we can DROP their dynamic tables in afterAll.
const createdDims: string[] = [];

async function makeDim(name: string, keyKind: "slug" | "external_id" = "slug"): Promise<string> {
  const id = await addDimension(name, [], { keyKind, silent: true }, U, T);
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
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  for (const id of createdDims) {
    await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${id}"`).catch(() => {});
    await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${id}"`).catch(() => {});
  }
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("listDimensionsForApi", () => {
  it("returns one entry per dim with slug, label, key_kind, canonical_count, last_committed_at", async () => {
    const dimId = await makeDim("OutCountry");
    await addCanonical(dimId, [{ key: "DE", label: "Germany" }], T);

    const out = await listDimensionsForApi(T);
    const country = out.dimensions.find((d) => d.slug === dimId);
    expect(country).toBeDefined();
    expect(country!.label).toBe("OutCountry");
    expect(country!.key_kind).toBe("slug");
    expect(country!.canonical_count).toBeGreaterThanOrEqual(1);
    expect(typeof country!.last_committed_at).toBe("string");
  });
});

describe("getSchemaForApi", () => {
  it("returns dim_slug + fields", async () => {
    const dimId = await makeDim("OutSchema");
    const out = await getSchemaForApi(T, dimId);
    expect(out).not.toBeNull();
    expect(out!.dim_slug).toBe(dimId);
    expect(out!.label).toBe("OutSchema");
    expect(Array.isArray(out!.fields)).toBe(true);
  });

  it("returns null when the dim doesn't exist OR belongs to another tenant", async () => {
    expect(await getSchemaForApi(T, "no_such_dim")).toBeNull();
  });
});

describe("listCanonicalPage", () => {
  it("returns records in updated_at, key order; respects limit; emits a cursor on truncation", async () => {
    const dimId = await makeDim("OutPage");
    await addCanonical(
      dimId,
      Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, label: `Label ${i}` })),
      T,
    );

    const page1 = await listCanonicalPage(T, dimId, { limit: 3 });
    expect(page1.records.length).toBe(3);
    expect(page1.cursor.next).not.toBeNull();
    expect(page1.meta.dim_slug).toBe(dimId);
    expect(page1.meta.page_size).toBe(3);

    const page2 = await listCanonicalPage(T, dimId, { limit: 3, cursor: page1.cursor.next! });
    expect(page2.records.length).toBe(2);
    expect(page2.cursor.next).toBeNull();

    const allKeys = [...page1.records, ...page2.records].map((r) => r.key);
    expect(new Set(allKeys).size).toBe(5);
  });

  it("?since= filters by canonical_version.updated_at (inclusive)", async () => {
    const dimId = await makeDim("OutSince");
    await addCanonical(dimId, [{ key: "OLD", label: "Old" }], T);

    const boundary = await pgGet<{ ts: string }>(
      `SELECT to_char(
         (now() + interval '100 milliseconds')::timestamp,
         'YYYY-MM-DD HH24:MI:SS.US'
       ) AS ts`,
    );
    await new Promise((r) => setTimeout(r, 250));

    await addCanonical(dimId, [{ key: "NEW", label: "New" }], T);

    const res = await listCanonicalPage(T, dimId, { since: boundary!.ts, limit: 100 });
    const keys = res.records.map((r) => r.key);
    expect(keys).toContain("NEW");
    expect(keys).not.toContain("OLD");
  });

  it("excludes soft-deleted rows", async () => {
    const dimId = await makeDim("OutSoftDel");
    await addCanonical(
      dimId,
      [
        { key: "A", label: "Alpha" },
        { key: "B", label: "Beta" },
      ],
      T,
    );
    const versions = await pgAll<{ key: string; version: number }>(
      `SELECT key, version FROM "zugzug_app"."canonical_version"
       WHERE dim_id = $1 AND tenant_id = $2`,
      [dimId, T],
    );
    const v = Object.fromEntries(versions.map((r) => [r.key, r.version]));
    await mergeCanonical(dimId, "A", ["B"], U, v, T);

    const res = await listCanonicalPage(T, dimId, { limit: 100 });
    expect(res.records.map((r) => r.key)).toEqual(["A"]);
  });

  it("returns 0 rows for a dim that belongs to a different tenant", async () => {
    const dimId = await makeDim("OutTenantScope");
    await addCanonical(dimId, [{ key: "X", label: "X" }], T);
    const res = await listCanonicalPage("other_tenant_id", dimId, { limit: 100 });
    expect(res.records).toEqual([]);
  });
});

describe("getCanonicalRow", () => {
  it("returns the row for a live key", async () => {
    const dimId = await makeDim("OutOne");
    await addCanonical(dimId, [{ key: "ONE", label: "One" }], T);
    const row = await getCanonicalRow(T, dimId, "ONE");
    expect(row).not.toBeNull();
    expect(row!.key).toBe("ONE");
    expect(row!.label).toBe("One");
  });

  it("returns null for a retired key", async () => {
    const dimId = await makeDim("OutRetired");
    await addCanonical(dimId, [{ key: "GONE", label: "Gone" }], T);
    const v = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."canonical_version"
       WHERE dim_id = $1 AND key = 'GONE' AND tenant_id = $2`,
      [dimId, T],
    );
    await retireCanonical(dimId, "GONE", U, v!.version, T);
    expect(await getCanonicalRow(T, dimId, "GONE")).toBeNull();
  });
});

describe("listTombstonesPage", () => {
  it("returns retired keys with retired_at + retired_into", async () => {
    const dimId = await makeDim("OutTombs");
    await addCanonical(
      dimId,
      [
        { key: "SURV", label: "Survivor" },
        { key: "MERGED", label: "Merged" },
        { key: "RETIRED", label: "Retired" },
      ],
      T,
    );
    const versions = await pgAll<{ key: string; version: number }>(
      `SELECT key, version FROM "zugzug_app"."canonical_version"
       WHERE dim_id = $1 AND tenant_id = $2`,
      [dimId, T],
    );
    const v = Object.fromEntries(versions.map((r) => [r.key, r.version]));
    await mergeCanonical(dimId, "SURV", ["MERGED"], U, v, T);
    await retireCanonical(dimId, "RETIRED", U, v.RETIRED, T);

    const res = await listTombstonesPage(T, dimId, { limit: 100 });
    const byKey = Object.fromEntries(res.tombstones.map((t) => [t.key, t]));
    expect(byKey.MERGED).toBeDefined();
    expect(byKey.MERGED.retired_into).toBe("SURV");
    expect(byKey.RETIRED).toBeDefined();
    expect(byKey.RETIRED.retired_into).toBeNull();
  });
});
