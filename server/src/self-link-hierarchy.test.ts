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
});
