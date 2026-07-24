process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun, pgAll } from "./pg.ts";
import { createTable } from "./tables.ts";
import { getRefTable, listFields } from "./repo-record.ts";

const T = "test_file_mode";
const U = "u_test_file_mode";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'File Mode', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'File Tester', 'file@example.test', 'FT', false) ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  // Drop the physical dim_/map_ tables so the test is rerun-safe.
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

describe("createTable() file mode", () => {
  it("creates the table, a text field per column, and a record per row", async () => {
    const { id } = await createTable(
      {
        name: "Customers FM",
        mode: "file",
        file: {
          columns: ["Region", "Tier"],
          rows: [
            { label: "Acme Corp", fields: { Region: "EMEA", Tier: "gold" } },
            { label: "Globex", fields: { Region: "AMER", Tier: "silver" } },
          ],
        },
      },
      U,
      T,
    );

    // Columns from the CSV headers became text fields.
    const fields = await listFields(id, T);
    expect(fields.map((f) => f.label).sort()).toEqual(["Region", "Tier"]);
    expect(fields.every((f) => f.type === "text")).toBe(true);

    // Rows became records, with the field values imported.
    const refTable = await getRefTable(id, T);
    expect(refTable).not.toBeNull();
    expect(refTable!.record.map((c) => c.label).sort()).toEqual(["Acme Corp", "Globex"]);

    const regionField = fields.find((f) => f.label === "Region")!.field;
    const acme = refTable!.record.find((c) => c.label === "Acme Corp")!;
    expect(acme.fields?.[regionField]).toBe("EMEA");
  });

  it("defaults ownership to the creator", async () => {
    const { id } = await createTable(
      {
        name: "Owned FM",
        mode: "file",
        file: { columns: [], rows: [{ label: "Solo", fields: {} }] },
      },
      U,
      T,
    );
    const [row] = await pgAll<{ owner_user_id: string | null }>(
      `SELECT owner_user_id FROM "zugzug_app"."reference_table" WHERE id = $1 AND tenant_id = $2`,
      [id, T],
    );
    expect(row?.owner_user_id).toBe(U);
  });
});
