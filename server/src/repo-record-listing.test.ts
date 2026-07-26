process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun } from "./pg.ts";
import { pgAll } from "./repo-shared.ts";
import { addRefTable, listRefTables, deleteRefTable } from "./repo-record.ts";
import { saveDraft, commit } from "./repo-drafts.ts";

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
});
