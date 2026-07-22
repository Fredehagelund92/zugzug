process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun, pgAll } from "./pg.ts";
import {
  addDimension,
  addCanonicalOne,
  addField,
  setFieldValue,
  listFields,
  getDimension,
} from "./repo-canonical.ts";

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
  const dims = await pgAll<{ dim_table: string; map_table: string }>(
    `SELECT dim_table, map_table FROM "zugzug_app"."dimension" WHERE tenant_id = $1`,
    [T],
  ).catch(() => []);
  for (const d of dims) {
    await pgRun(`DROP TABLE IF EXISTS ${d.dim_table}`).catch(() => {});
    await pgRun(`DROP TABLE IF EXISTS ${d.map_table}`).catch(() => {});
  }
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("self-referencing linked field", () => {
  it("allows a linked field to target its own table", async () => {
    const dimId = await addDimension("Regions", [], { keyKind: "slug" }, U, T);
    const added = await addField(
      dimId,
      "Parent",
      "linked",
      undefined,
      { referencedDimId: dimId },
      U,
      T,
    );
    expect(added).not.toBeNull();
    const parent = (await listFields(dimId, T)).find((f) => f.field === "parent");
    expect(parent?.referencedDimId).toBe(dimId);
  });

  it("builds a valid parent chain, rejects cycles and self-parenting", async () => {
    const dimId = await addDimension("Geo", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "Europe", "europe", U, T);
    await addCanonicalOne(dimId, "Nordics", "nordics", U, T);
    await addCanonicalOne(dimId, "Denmark", "denmark", U, T);
    await addCanonicalOne(dimId, "France", "france", U, T);
    await addField(dimId, "Parent", "linked", undefined, { referencedDimId: dimId }, U, T);

    // Valid chain: Denmark -> Nordics -> Europe
    await setFieldValue(dimId, "nordics", "parent", "europe", U, T);
    await setFieldValue(dimId, "denmark", "parent", "nordics", U, T);
    const chain = await getDimension(dimId, T);
    expect(chain!.canonical.find((c) => c.key === "denmark")!.fields?.parent).toBe("nordics");

    // Cycle: Europe's parent = Denmark would close the loop
    await expect(setFieldValue(dimId, "europe", "parent", "denmark", U, T)).rejects.toThrow(
      /loop/i,
    );

    // Self-parent is rejected
    await expect(setFieldValue(dimId, "europe", "parent", "europe", U, T)).rejects.toThrow(
      /own parent/i,
    );

    // Acyclic re-parent still works: France Europe -> Nordics
    await setFieldValue(dimId, "france", "parent", "europe", U, T);
    await setFieldValue(dimId, "france", "parent", "nordics", U, T);
    const after = await getDimension(dimId, T);
    expect(after!.canonical.find((c) => c.key === "france")!.fields?.parent).toBe("nordics");
  });

  it("a cross-table linked field still coerces an unknown key to null", async () => {
    const a = await addDimension("Alpha", [], { keyKind: "slug" }, U, T);
    const b = await addDimension("Beta", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(a, "One", "one", U, T);
    await addField(a, "BetaLink", "linked", undefined, { referencedDimId: b }, U, T);
    // Unknown FK on a NON-self link: no throw, coerced to null.
    await setFieldValue(a, "one", "betalink", "does_not_exist", U, T);
    const dim = await getDimension(a, T);
    expect(dim!.canonical.find((c) => c.key === "one")!.fields?.betalink ?? null).toBeNull();
  });
});
