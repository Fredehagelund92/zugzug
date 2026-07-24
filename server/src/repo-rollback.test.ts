process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgAll, pgRun } from "./pg.ts";
import { addRefTable, addRecordOne } from "./repo-record.ts";
import { saveDraft, commit } from "./repo-drafts.ts";
import { listVersions } from "./repo-versions.ts";
import { rollbackToVersion } from "./repo-rollback.ts";
import { refTableMeta, cq } from "./repo-shared.ts";

const T = "test_rollback";
const U = "u_test_rollback";
const ADMIN = "u_rollback_admin";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'RollbackTest', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Rollback User', 'rb@example.test', 'RB', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Rollback Admin', 'rba@example.test', 'RA', false)
     ON CONFLICT DO NOTHING`,
    [ADMIN],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."draft" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = ANY($1)`, [[U, ADMIN]]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

/** List all record rows for a refTable directly from the dim_ table. */
async function listRecords(
  refTableId: string,
  tenantId: string,
): Promise<Array<{ key: string; label: string | null }>> {
  const meta = await refTableMeta(refTableId, tenantId);
  if (!meta) return [];
  const rows = await pgAll<Record<string, unknown>>(`SELECT * FROM ${cq(meta.dimTable)}`).catch(
    () => [] as Record<string, unknown>[],
  );
  return rows.map((r) => ({
    key: String(r[meta.keyCol] ?? ""),
    label: r.label != null ? String(r.label) : null,
  }));
}

describe("rollbackToVersion", () => {
  it("rollback restores content and publishes a new version", async () => {
    const refTableId = await addRefTable("RbDim1", [], { keyKind: "slug" }, U, T);

    // Stage + commit v1: one record record "United States"
    await addRecordOne(refTableId, "United States", "united_states", U, T);
    await saveDraft(refTableId, "usa", "mapped", "United States", "united_states", U, T);
    await commit(refTableId, U, T);
    const v1 = (await listVersions(refTableId, T))[0]!.version;

    // Stage + commit v2: add a "Mistake Record"
    await addRecordOne(refTableId, "Mistake Record", "mistake_record", U, T);
    await saveDraft(refTableId, "mistake", "mapped", "Mistake Record", "mistake_record", U, T);
    await commit(refTableId, U, T);

    // Rollback to v1
    const res = await rollbackToVersion(refTableId, T, v1, ADMIN);

    expect(res.restoredVersion).toBe(v1);
    // ATTACH_WAREHOUSE=false → no writable adapter → warehouse block is skipped
    expect(res.warehouseSynced).toBe("n/a");

    // New version is kind=rollback
    const versions = await listVersions(refTableId, T);
    expect(versions[0]!.kind).toBe("rollback");
    expect(versions[0]!.restoresVersion).toBe(v1);

    // Record rows reflect the v1 snapshot: mistake gone, united_states present
    const rows = await listRecords(refTableId, T);
    expect(rows.some((r) => r.label === "Mistake Record")).toBe(false);
    expect(rows.some((r) => r.key === "united_states")).toBe(true);
  });

  it("rollback preserves staged drafts", async () => {
    const refTableId = await addRefTable("RbDim2", [], { keyKind: "slug" }, U, T);

    // v1
    await addRecordOne(refTableId, "Alpha", "alpha", U, T);
    await saveDraft(refTableId, "alpha_raw", "mapped", "Alpha", "alpha", U, T);
    await commit(refTableId, U, T);
    const v1 = (await listVersions(refTableId, T))[0]!.version;

    // v2: add Beta
    await addRecordOne(refTableId, "Beta", "beta", U, T);
    await saveDraft(refTableId, "beta_raw", "mapped", "Beta", "beta", U, T);
    await commit(refTableId, U, T);

    // Stage a draft AFTER v2 but BEFORE rollback
    await saveDraft(refTableId, "gamma_raw", "mapped", "Gamma", "gamma", U, T);

    // Rollback to v1
    await rollbackToVersion(refTableId, T, v1, ADMIN);

    // Draft for "gamma_raw" must still be in the staging table
    const drafts = await pgAll<{ raw: string }>(
      `SELECT raw FROM "zugzug_app"."draft" WHERE reference_table_id = $1 AND tenant_id = $2 AND raw = 'gamma_raw'`,
      [refTableId, T],
    );
    expect(drafts).toHaveLength(1);
  });

  it("rollback to a snapshotless version 409s", async () => {
    const refTableId = await addRefTable("RbDim3", [], { keyKind: "slug" }, U, T);
    await expect(rollbackToVersion(refTableId, T, 999, ADMIN)).rejects.toThrow(
      /NO_SNAPSHOT|no snapshot/i,
    );
  });
});
