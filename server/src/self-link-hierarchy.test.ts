process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun, pgAll } from "./pg.ts";
import {
  addRefTable,
  addRecordOne,
  addField,
  setFieldValue,
  listFields,
  getRefTable,
} from "./repo-record.ts";

const T = "test_hierarchy";
const U = "u_test_hierarchy";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'Hierarchy', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Hierarchy Tester', 'h@example.test', 'HT', false) ON CONFLICT DO NOTHING`,
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

describe("self-referencing linked field", () => {
  it("allows a linked field to target its own table", async () => {
    const refTableId = await addRefTable("Regions", [], { keyKind: "slug" }, U, T);
    const added = await addField(
      refTableId,
      "Parent",
      "linked",
      undefined,
      { referencedRefTableId: refTableId },
      U,
      T,
    );
    expect(added).not.toBeNull();
    const parent = (await listFields(refTableId, T)).find((f) => f.field === "parent");
    expect(parent?.referencedRefTableId).toBe(refTableId);
  });

  it("builds a valid parent chain, rejects cycles and self-parenting", async () => {
    const refTableId = await addRefTable("Geo", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Europe", "europe", U, T);
    await addRecordOne(refTableId, "Nordics", "nordics", U, T);
    await addRecordOne(refTableId, "Denmark", "denmark", U, T);
    await addRecordOne(refTableId, "France", "france", U, T);
    await addField(
      refTableId,
      "Parent",
      "linked",
      undefined,
      { referencedRefTableId: refTableId },
      U,
      T,
    );

    // Valid chain: Denmark -> Nordics -> Europe
    await setFieldValue(refTableId, "nordics", "parent", "europe", U, T);
    await setFieldValue(refTableId, "denmark", "parent", "nordics", U, T);
    const chain = await getRefTable(refTableId, T);
    expect(chain!.record.find((c) => c.key === "denmark")!.fields?.parent).toBe("nordics");

    // Cycle: Europe's parent = Denmark would close the loop
    await expect(setFieldValue(refTableId, "europe", "parent", "denmark", U, T)).rejects.toThrow(
      /loop/i,
    );

    // Self-parent is rejected
    await expect(setFieldValue(refTableId, "europe", "parent", "europe", U, T)).rejects.toThrow(
      /own parent/i,
    );

    // Acyclic re-parent still works: France Europe -> Nordics
    await setFieldValue(refTableId, "france", "parent", "europe", U, T);
    await setFieldValue(refTableId, "france", "parent", "nordics", U, T);
    const after = await getRefTable(refTableId, T);
    expect(after!.record.find((c) => c.key === "france")!.fields?.parent).toBe("nordics");
  });

  it("a cross-table linked field still coerces an unknown key to null", async () => {
    const a = await addRefTable("Alpha", [], { keyKind: "slug" }, U, T);
    const b = await addRefTable("Beta", [], { keyKind: "slug" }, U, T);
    await addRecordOne(a, "One", "one", U, T);
    await addField(a, "BetaLink", "linked", undefined, { referencedRefTableId: b }, U, T);
    // Unknown FK on a NON-self link: no throw, coerced to null.
    await setFieldValue(a, "one", "betalink", "does_not_exist", U, T);
    const refTable = await getRefTable(a, T);
    expect(refTable!.record.find((c) => c.key === "one")!.fields?.betalink ?? null).toBeNull();
  });
});
