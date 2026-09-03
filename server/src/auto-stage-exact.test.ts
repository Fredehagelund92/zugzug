process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun } from "./pg.ts";
import { pgAll } from "./repo-shared.ts";
import { addRefTable, addRecordOne, deleteRefTable } from "./repo-record.ts";
import { autoStageExactMatches, stageExactMatchDrafts } from "./repo-scan.ts";
import { listDrafts, commit } from "./repo-drafts.ts";

async function metaOf(refTableId: string): Promise<{
  dimTable: string;
  mapTable: string;
  keyCol: string;
}> {
  const [m] = await pgAll<{ dimTable: string; mapTable: string; keyCol: string }>(
    `SELECT dim_table AS "dimTable", map_table AS "mapTable", key_col AS "keyCol"
       FROM "zugzug_app"."reference_table" WHERE id = $1 AND tenant_id = $2`,
    [refTableId, T],
  );
  return m;
}

const T = "test_autostage";
const U = "u_autostage";

async function dropDims(): Promise<void> {
  const refTables = await pgAll<{ id: string }>(
    `SELECT id FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`,
    [T],
  ).catch(() => [] as { id: string }[]);
  for (const d of refTables) await deleteRefTable(d.id, "test-teardown", T).catch(() => {});
}

async function seedSourceValue(refTableId: string, raw: string, rows: number): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."source_scan_value"
       (tenant_id, reference_table_id, raw, raw_lower, total_rows, scanned_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id, reference_table_id, raw_lower) DO NOTHING`,
    [T, refTableId, raw, raw.toLowerCase(), rows],
  );
}

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'AutoStage', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Auto Stage', 'as@example.test', 'AS', false) ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await dropDims();
  await pgRun(`DELETE FROM "zugzug_app"."source_scan_value" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."draft" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

// #154: autoStageExactMatches now does the exact-match diff set-based in SQL
// instead of materializing whole tables into the Bun process. Behaviour must be
// preserved: stage a u_system draft for each source raw that matches a record
// label case-insensitively and isn't already mapped.
// stageExactMatchDrafts is the set-based diff #154 introduced; test it directly
// so we don't need a live warehouse to satisfy the liveSources gate.
describe("stageExactMatchDrafts (#154)", () => {
  it("stages exact label matches, counts unmatched, and excludes already-mapped", async () => {
    const refTableId = await addRefTable("AutoCountry", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "United States", undefined, U, T);
    await addRecordOne(refTableId, "Germany", undefined, U, T);

    // Two source values match a record label (case-insensitively), one doesn't.
    await seedSourceValue(refTableId, "united states", 100);
    await seedSourceValue(refTableId, "GERMANY", 50);
    await seedSourceValue(refTableId, "france", 25);

    const res = await stageExactMatchDrafts(refTableId, T, await metaOf(refTableId));
    expect(res.matched).toBe(2);
    expect(res.unmatched).toBe(1);

    // Assert on the raw draft rows — listDrafts enriches user_id via a users
    // join, and u_system isn't seeded in this test's users table.
    const staged = await pgAll<{ raw: string; user_id: string; status: string }>(
      `SELECT raw, user_id, status FROM "zugzug_app"."draft"
        WHERE reference_table_id = $1 AND tenant_id = $2 AND status = 'mapped'
        ORDER BY raw`,
      [refTableId, T],
    );
    expect(staged.length).toBe(2);
    expect(staged.every((d) => d.user_id === "u_system")).toBe(true);
    expect(staged.map((d) => d.raw)).toEqual(["GERMANY", "united states"]);

    // Publish the staged drafts, then re-run: the now-mapped raws must be
    // excluded, leaving only the unmatched "france".
    await commit(refTableId, U, T);
    const again = await stageExactMatchDrafts(refTableId, T, await metaOf(refTableId));
    expect(again.matched).toBe(0);
    expect(again.unmatched).toBe(1);
  });

  it("does not duplicate-stage when two records share a label case-insensitively", async () => {
    const refTableId = await addRefTable("AutoDup", [], { keyKind: "slug" }, U, T);
    // Two distinct records whose labels collide when lower-cased. The keys must
    // be given explicitly — derived from the labels they would both slug to
    // "acme", which is now a duplicate-key refusal, not a second record.
    await addRecordOne(refTableId, "Acme", "acme_one", U, T);
    await addRecordOne(refTableId, "ACME", "acme_two", U, T);
    await seedSourceValue(refTableId, "acme", 5);

    // DISTINCT ON (v.raw) must keep the INSERT to a single draft per raw —
    // otherwise ON CONFLICT would error touching the same row twice.
    const res = await stageExactMatchDrafts(refTableId, T, await metaOf(refTableId));
    expect(res.matched).toBe(1);
    const staged = (await listDrafts(refTableId, T)).filter((d) => d.raw === "acme");
    expect(staged.length).toBe(1);
  });
});

describe("autoStageExactMatches gate (#154)", () => {
  it("returns zero for a table with no wired sources", async () => {
    const refTableId = await addRefTable("AutoNoSource", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Alpha", undefined, U, T);
    await seedSourceValue(refTableId, "alpha", 10);
    const res = await autoStageExactMatches(refTableId, T);
    expect(res).toEqual({ matched: 0, unmatched: 0 });
  });
});
