process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun, pgGet } from "./pg.ts";
import { pgAll } from "./repo-shared.ts";
import {
  addRefTable,
  addRecordOne,
  addField,
  setFieldValue,
  renameRecord,
  deleteRefTable,
} from "./repo-record.ts";
import { listRecordHistory } from "./repo-activity.ts";
import { listAudit } from "./repo-meta.ts";

const T = "test_record_history";
const U = "u_test_history";

// Drop every refTable in the tenant (physical dim_/map_ tables included) plus
// its audit rows — so each run starts clean even after an aborted prior run.
async function cleanTenant() {
  const refTables = await pgAll<{ id: string }>(
    `SELECT id FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`,
    [T],
  ).catch(() => []);
  for (const d of refTables) await deleteRefTable(d.id, U, T).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
}

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'History', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'History Tester', 'h@example.test', 'HT', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
  await cleanTenant();
});

afterAll(async () => {
  await cleanTenant();
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("listRecordHistory", () => {
  it("captures a field edit as before → after metadata, newest first", async () => {
    const refTableId = await addRefTable("Countries", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "United States", "usa", U, T);
    await addField(refTableId, "Region", "text", undefined, {}, U, T);

    await setFieldValue(refTableId, "usa", "region", "Americas", U, T);
    await setFieldValue(refTableId, "usa", "region", "Europe", U, T);

    const { entries } = await listRecordHistory(refTableId, "usa", T);
    // Newest first: the Europe edit leads.
    const top = entries[0]!;
    expect(top.action).toBe("Edited record");
    expect(top.metadata).toMatchObject({ field: "region", before: "Americas", after: "Europe" });

    // The very first set recorded an empty "before".
    const firstSet = entries.find(
      (e) => (e.metadata as Record<string, unknown> | null)?.after === "Americas",
    );
    expect(firstSet).toBeDefined();
    expect((firstSet!.metadata as Record<string, unknown>).before).toBeNull();

    // The record's creation is in history too.
    expect(entries.some((e) => e.action === "Added record")).toBe(true);
  });

  it("records a rename as a Name before → after diff", async () => {
    const refTableId = await addRefTable("RenameDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "USA", "usa", U, T);
    const v = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."record_version" WHERE tenant_id = $1 AND reference_table_id = $2 AND key = $3`,
      [T, refTableId, "usa"],
    );
    await renameRecord(refTableId, "usa", "United States", U, v?.version ?? 1, T);

    const { entries } = await listRecordHistory(refTableId, "usa", T);
    expect(entries[0]!.action).toBe("Renamed record");
    expect(entries[0]!.metadata).toMatchObject({
      label: "Name",
      before: "USA",
      after: "United States",
    });
  });

  it("scopes strictly to one record and paginates by keyset cursor", async () => {
    const refTableId = await addRefTable("ScopeDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Alpha", "alpha", U, T);
    await addRecordOne(refTableId, "Beta", "beta", U, T);
    await addField(refTableId, "Note", "text", undefined, {}, U, T);
    await setFieldValue(refTableId, "beta", "note", "beta-only", U, T);
    await setFieldValue(refTableId, "alpha", "note", "one", U, T);
    await setFieldValue(refTableId, "alpha", "note", "two", U, T);

    // Nothing from `beta` bleeds into `alpha`'s history.
    const all = await listRecordHistory(refTableId, "alpha", T);
    expect(
      all.entries.every((e) => e.detail.includes("alpha") || e.action === "Added record"),
    ).toBe(true);
    expect(all.entries.some((e) => e.detail.includes("beta-only"))).toBe(false);

    // limit=1 yields a cursor; the next page continues older.
    const page1 = await listRecordHistory(refTableId, "alpha", T, { limit: 1 });
    expect(page1.entries).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listRecordHistory(refTableId, "alpha", T, {
      limit: 1,
      before: page1.nextCursor!,
    });
    expect(page2.entries).toHaveLength(1);
    expect(page2.entries[0]!.id).not.toBe(page1.entries[0]!.id);
  });

  it("returns audit metadata as a parsed object, not a raw jsonb string", async () => {
    const refTableId = await addRefTable("MetaDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Norway", "norway", U, T);
    await addField(refTableId, "Region", "text", undefined, {}, U, T);
    await setFieldValue(refTableId, "norway", "region", "Europe", U, T);

    const feed = await listAudit(50, T);
    const edit = feed.find((e) => e.action === "Edited record" && e.detail.includes("norway"));
    expect(edit).toBeDefined();
    // The activity feed expands metadata as key/value — it must be an object.
    expect(typeof edit!.metadata).toBe("object");
    expect(edit!.metadata).toMatchObject({ field: "region", after: "Europe" });
  });

  it("does not leak history across tenants", async () => {
    const refTableId = await addRefTable("TenantDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Secret", "secret", U, T);
    // A different tenant sees nothing for this (table, row).
    const other = await listRecordHistory(refTableId, "secret", "some_other_tenant");
    expect(other.entries).toHaveLength(0);
  });
});
