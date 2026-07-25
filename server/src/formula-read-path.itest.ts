process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun, pgAll, pgGet } from "./pg.ts";
import {
  addRefTable,
  addRecordOne,
  addField,
  setFieldValue,
  listFields,
  getRefTable,
  validateTableFormula,
  updateField,
} from "./repo-record.ts";
import { saveDraft, commit } from "./repo-drafts.ts";
import { listVersions, getSnapshot } from "./repo-versions.ts";

const T = "test_formula";
const U = "u_test_formula";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'Formula', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Formula Tester', 'f@example.test', 'FT', false) ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  const refTables = await pgAll<{ dim_table: string; map_table: string }>(
    `SELECT dim_table, map_table FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`,
    [T],
  ).catch(() => []);
  for (const d of refTables) {
    await pgRun(`DROP TABLE IF EXISTS ${d.dim_table}`).catch(() => {});
    await pgRun(`DROP TABLE IF EXISTS ${d.map_table}`).catch(() => {});
  }
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

let seq = 0;
async function seedTable() {
  // Unique table per call — addRefTable is idempotent on slug, so a shared name
  // would bleed fields (and ON CONFLICT DO NOTHING) across tests.
  const refTableId = await addRefTable(`Products ${++seq}`, [], { keyKind: "slug" }, U, T);
  await addField(refTableId, "Price", "number", undefined, {}, U, T);
  await addRecordOne(refTableId, "Widget", "widget", U, T);
  await setFieldValue(refTableId, "widget", "price", "100", U, T);
  return refTableId;
}

describe("formula field — read path", () => {
  it("adds a formula field WITHOUT a physical dim_ column", async () => {
    const refTableId = await seedTable();
    const dim = (await pgGet<{ dim_table: string }>(
      `SELECT dim_table FROM "zugzug_app"."reference_table" WHERE id = $1`,
      [refTableId],
    ))!.dim_table;

    const added = await addField(
      refTableId,
      "Status",
      "formula",
      undefined,
      { formula: { expr: 'IF(Price > 50, "premium", "basic")', resultType: "text" } },
      U,
      T,
    );
    expect(added).not.toBeNull();

    // The field metadata exists…
    const status = (await listFields(refTableId, T)).find((f) => f.field === "status");
    expect(status?.type).toBe("formula");
    expect(status?.formula?.expr).toBe('IF(Price > 50, "premium", "basic")');

    // …but no physical column was created on the dim_ table.
    const col = await pgGet(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'zugzug_app' AND table_name = $1 AND column_name = 'status'`,
      [dim.replace(/^zugzug_app\./, "").replace(/"/g, "")],
    );
    expect(col).toBeNull();
  });

  it("computes the formula per row in getRefTable", async () => {
    const refTableId = await seedTable();
    await addField(
      refTableId,
      "Status",
      "formula",
      undefined,
      { formula: { expr: 'IF(Price > 50, "premium", "basic")', resultType: "text" } },
      U,
      T,
    );
    const table = await getRefTable(refTableId, T);
    const widget = table?.record.find((r) => r.key === "widget");
    expect(widget?.fields?.status).toBe("premium");
  });

  it("rejects a formula referencing an unknown field", async () => {
    const refTableId = await seedTable();
    const added = await addField(
      refTableId,
      "Bad",
      "formula",
      undefined,
      { formula: { expr: "Nonexistent + 1", resultType: "number" } },
      U,
      T,
    );
    expect(added).toBeNull();
  });

  it("setFieldValue is a no-op on a formula field (read-only)", async () => {
    const refTableId = await seedTable();
    await addField(
      refTableId,
      "Status",
      "formula",
      undefined,
      { formula: { expr: '"x"', resultType: "text" } },
      U,
      T,
    );
    // Should not throw and should not alter anything (no physical column).
    await setFieldValue(refTableId, "widget", "status", "hacked", U, T);
    const table = await getRefTable(refTableId, T);
    expect(table?.record.find((r) => r.key === "widget")?.fields?.status).toBe("x");
  });

  it("validateTableFormula reports errors, sample values, and per-row warnings", async () => {
    const refTableId = await seedTable();
    const bad = await validateTableFormula(refTableId, "IF(Price >", T);
    expect(bad.ok).toBe(false);

    const good = await validateTableFormula(refTableId, "Price * 2", T);
    expect(good.ok).toBe(true);
    expect(good.sample).toBe("200");

    // Valid formula, but this row divides by zero → non-blocking warning.
    const warn = await validateTableFormula(refTableId, "Price / 0", T);
    expect(warn.ok).toBe(true);
    expect(warn.warning).toBeDefined();
  });
});

describe("formula field — editing", () => {
  it("re-validates and recomputes when the expression is edited", async () => {
    const refTableId = await seedTable(); // Widget, price 100
    await addField(
      refTableId,
      "Status",
      "formula",
      undefined,
      { formula: { expr: 'IF(Price > 50, "premium", "basic")', resultType: "text" } },
      U,
      T,
    );
    // Edit the expression via the shared field_config merge path.
    await updateField(
      refTableId,
      "status",
      {
        fieldConfig: JSON.stringify({
          expr: 'IF(Price > 200, "premium", "basic")',
          resultType: "text",
        }),
      },
      U,
      T,
    );
    const table = await getRefTable(refTableId, T);
    // Price 100 is now below the new 200 threshold → "basic".
    expect(table?.record.find((r) => r.key === "widget")?.fields?.status).toBe("basic");
  });

  it("rejects an edit to an invalid expression (unknown field)", async () => {
    const refTableId = await seedTable();
    await addField(
      refTableId,
      "Status",
      "formula",
      undefined,
      { formula: { expr: '"x"', resultType: "text" } },
      U,
      T,
    );
    await expect(
      updateField(
        refTableId,
        "status",
        { fieldConfig: JSON.stringify({ expr: "Nonexistent + 1", resultType: "number" }) },
        U,
        T,
      ),
    ).rejects.toThrow();
  });
});

describe("formula field — publish path", () => {
  it("injects computed (and variants-derived) values into the published snapshot", async () => {
    const refTableId = await seedTable(); // Widget, price 100
    await addField(
      refTableId,
      "Status",
      "formula",
      undefined,
      { formula: { expr: 'IF(Price > 50, "premium", "basic")', resultType: "text" } },
      U,
      T,
    );
    await addField(
      refTableId,
      "Popular",
      "formula",
      undefined,
      { formula: { expr: "IF(variants > 0, TRUE, FALSE)", resultType: "boolean" } },
      U,
      T,
    );
    // A mapping gives Widget one variant, so `variants` computes to 1 at publish.
    await saveDraft(refTableId, "widg raw", "mapped", "Widget", "widget", U, T);
    await commit(refTableId, U, T);

    const versions = await listVersions(refTableId, T);
    const snap = await getSnapshot(refTableId, T, versions[0].version);
    const widget = snap!.records.find((r) => r.label === "Widget" || r.status != null);
    expect(widget?.status).toBe("premium"); // virtual column present in snapshot
    expect(widget?.popular).toBe(true); // variants recomputed for the snapshot
  });
});
