process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import "../test/setup.ts";
import { pgRun } from "./pg.ts";
import { pgAll, cq } from "./repo-shared.ts";
import { env } from "./env.ts";
import { addRefTable, addRecordOne, deleteRefTable } from "./repo-record.ts";
import { saveDraft } from "./repo-drafts.ts";
import { getPreferences, setPreferences } from "./repo-meta.ts";
import { autoCommitJob } from "./scheduler-jobs.ts";
import { TenantRepo } from "./tenant-repo.ts";

const T = "test_autocommit";
const U = "u_autocommit";
const WD = "wd_autocommit";

let attachWarehouseBefore = false;

async function mapTableOf(refTableId: string): Promise<string> {
  const [m] = await pgAll<{ mapTable: string }>(
    `SELECT map_table AS "mapTable" FROM "zugzug_app"."reference_table" WHERE id = $1 AND tenant_id = $2`,
    [refTableId, T],
  );
  return m.mapTable;
}

/** Rows in the published map table, as raw → key pairs. */
async function published(refTableId: string): Promise<Record<string, string>> {
  const table = await mapTableOf(refTableId);
  const [meta] = await pgAll<{ keyCol: string }>(
    `SELECT key_col AS "keyCol" FROM "zugzug_app"."reference_table" WHERE id = $1 AND tenant_id = $2`,
    [refTableId, T],
  );
  const rows = await pgAll<{ raw: string; k: string }>(
    `SELECT raw, "${meta.keyCol}" AS k FROM ${cq(table)}`,
  );
  return Object.fromEntries(rows.map((r) => [r.raw, r.k]));
}

async function drafts(
  refTableId: string,
): Promise<{ raw: string; user_id: string; key: string }[]> {
  return pgAll<{ raw: string; user_id: string; key: string }>(
    `SELECT raw, user_id, target_key AS key FROM "zugzug_app"."draft"
      WHERE reference_table_id = $1 AND tenant_id = $2 AND status = 'mapped'
      ORDER BY raw, user_id`,
    [refTableId, T],
  );
}

/** The auto-commit job only visits reference tables with a wired source. */
async function wire(refTableId: string): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."reference_table_source"
       (reference_table_id, tenant_id, database_id, schema_name, table_name, column_name)
     VALUES ($1, $2, $3, 'main', 'orders', 'country')`,
    [refTableId, T, WD],
  );
}

function runAutoCommit(): Promise<{ rowsScanned?: number }> {
  return autoCommitJob.run({
    signal: new AbortController().signal,
    tenantId: T,
    repo: new TenantRepo(T, "admin", true),
  });
}

beforeAll(async () => {
  attachWarehouseBefore = env.attachWarehouse;
  // The job's first guard; tests run with ATTACH_WAREHOUSE=false.
  env.attachWarehouse = true;
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'AutoCommit', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Auto Commit', 'ac@example.test', 'AC', false) ON CONFLICT DO NOTHING`,
    [U],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials)
     VALUES ('u_system', 'Auto-match', 'AM') ON CONFLICT DO NOTHING`,
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."warehouse_database" (id, database_name, label, added_at, added_by)
     VALUES ($1, $1, 'AutoCommit', now(), $2) ON CONFLICT DO NOTHING`,
    [WD, U],
  );
});

afterEach(async () => {
  const refTables = await pgAll<{ id: string }>(
    `SELECT id FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`,
    [T],
  ).catch(() => [] as { id: string }[]);
  for (const d of refTables) await deleteRefTable(d.id, "test-teardown", T).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."draft" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
});

afterAll(async () => {
  env.attachWarehouse = attachWarehouseBefore;
  await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE id = $1`, [WD]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

async function setAutoPublish(on: boolean): Promise<void> {
  await setPreferences({ ...(await getPreferences(T)), autoPublishEnabled: on }, T);
}

describe("autoCommitJob — publishes only its own exact matches", () => {
  it("publishes nothing when auto-publish is off (the default)", async () => {
    const refTableId = await addRefTable("AutoOff", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Germany", undefined, U, T);
    await addRecordOne(refTableId, "France", undefined, U, T);
    await saveDraft(refTableId, "GERMANY", "mapped", "Germany", "germany", "u_system", T);
    await saveDraft(refTableId, "fra", "mapped", "France", "france", U, T);
    await wire(refTableId);

    expect((await getPreferences(T)).autoPublishEnabled).toBe(false);
    const res = await runAutoCommit();
    expect(res).toEqual({});
    expect(await published(refTableId)).toEqual({});
    expect((await drafts(refTableId)).length).toBe(2);
  });

  it("publishes the u_system draft and leaves a teammate's draft awaiting publish", async () => {
    await setAutoPublish(true);
    const refTableId = await addRefTable("AutoMixed", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Germany", undefined, U, T);
    await addRecordOne(refTableId, "France", undefined, U, T);
    await saveDraft(refTableId, "GERMANY", "mapped", "Germany", "germany", "u_system", T);
    await saveDraft(refTableId, "fra", "mapped", "France", "france", U, T);
    await wire(refTableId);

    const res = await runAutoCommit();
    expect(res.rowsScanned).toBe(1);
    expect(await published(refTableId)).toEqual({ GERMANY: "germany" });
    expect(await drafts(refTableId)).toEqual([{ raw: "fra", user_id: U, key: "france" }]);
    await setAutoPublish(false);
  });

  it("keeps the u_system target when a teammate re-drafted the same source value later", async () => {
    await setAutoPublish(true);
    const refTableId = await addRefTable("AutoSameRaw", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Acme Inc", undefined, U, T);
    await addRecordOne(refTableId, "Acme Ltd", undefined, U, T);
    // Same source value drafted twice: u_system first, the teammate afterwards.
    await saveDraft(refTableId, "acme", "mapped", "Acme Inc", "acme_inc", "u_system", T);
    await saveDraft(refTableId, "acme", "mapped", "Acme Ltd", "acme_ltd", U, T);
    await pgRun(
      `UPDATE "zugzug_app"."draft" SET created_at = created_at + interval '1 hour'
        WHERE tenant_id = $1 AND reference_table_id = $2 AND user_id = $3`,
      [T, refTableId, U],
    );
    await wire(refTableId);

    const res = await runAutoCommit();
    expect(res.rowsScanned).toBe(1);
    // The newer human draft must NOT win — folding by source value alone would
    // have published acme_ltd with nobody signing off on it.
    expect(await published(refTableId)).toEqual({ acme: "acme_inc" });
    expect(await drafts(refTableId)).toEqual([{ raw: "acme", user_id: U, key: "acme_ltd" }]);
    await setAutoPublish(false);
  });
});
