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
  addDimension,
  addCanonicalOne,
  addField,
  setFieldValue,
  renameCanonical,
  deleteDimension,
} from "./repo-canonical.ts";
import { listRecordHistory } from "./repo-activity.ts";
import { listAudit } from "./repo-meta.ts";

const T = "test_record_history";
const U = "u_test_history";

// Drop every dimension in the tenant (physical dim_/map_ tables included) plus
// its audit rows — so each run starts clean even after an aborted prior run.
async function cleanTenant() {
  const dims = await pgAll<{ id: string }>(
    `SELECT id FROM "zugzug_app"."dimension" WHERE tenant_id = $1`,
    [T],
  ).catch(() => []);
  for (const d of dims) await deleteDimension(d.id, U, T).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(
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
    const dimId = await addDimension("Countries", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "United States", "usa", U, T);
    await addField(dimId, "Region", "text", undefined, {}, U, T);

    await setFieldValue(dimId, "usa", "region", "Americas", U, T);
    await setFieldValue(dimId, "usa", "region", "Europe", U, T);

    const { entries } = await listRecordHistory(dimId, "usa", T);
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
    expect(entries.some((e) => e.action === "Added canonical")).toBe(true);
  });

  it("records a rename as a Name before → after diff", async () => {
    const dimId = await addDimension("RenameDim", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "USA", "usa", U, T);
    const v = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1 AND dim_id = $2 AND key = $3`,
      [T, dimId, "usa"],
    );
    await renameCanonical(dimId, "usa", "United States", U, v?.version ?? 1, T);

    const { entries } = await listRecordHistory(dimId, "usa", T);
    expect(entries[0]!.action).toBe("Renamed canonical");
    expect(entries[0]!.metadata).toMatchObject({
      label: "Name",
      before: "USA",
      after: "United States",
    });
  });

  it("scopes strictly to one record and paginates by keyset cursor", async () => {
    const dimId = await addDimension("ScopeDim", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "Alpha", "alpha", U, T);
    await addCanonicalOne(dimId, "Beta", "beta", U, T);
    await addField(dimId, "Note", "text", undefined, {}, U, T);
    await setFieldValue(dimId, "beta", "note", "beta-only", U, T);
    await setFieldValue(dimId, "alpha", "note", "one", U, T);
    await setFieldValue(dimId, "alpha", "note", "two", U, T);

    // Nothing from `beta` bleeds into `alpha`'s history.
    const all = await listRecordHistory(dimId, "alpha", T);
    expect(
      all.entries.every((e) => e.detail.includes("alpha") || e.action === "Added canonical"),
    ).toBe(true);
    expect(all.entries.some((e) => e.detail.includes("beta-only"))).toBe(false);

    // limit=1 yields a cursor; the next page continues older.
    const page1 = await listRecordHistory(dimId, "alpha", T, { limit: 1 });
    expect(page1.entries).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listRecordHistory(dimId, "alpha", T, {
      limit: 1,
      before: page1.nextCursor!,
    });
    expect(page2.entries).toHaveLength(1);
    expect(page2.entries[0]!.id).not.toBe(page1.entries[0]!.id);
  });

  it("returns audit metadata as a parsed object, not a raw jsonb string", async () => {
    const dimId = await addDimension("MetaDim", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "Norway", "norway", U, T);
    await addField(dimId, "Region", "text", undefined, {}, U, T);
    await setFieldValue(dimId, "norway", "region", "Europe", U, T);

    const feed = await listAudit(50, T);
    const edit = feed.find((e) => e.action === "Edited record" && e.detail.includes("norway"));
    expect(edit).toBeDefined();
    // The activity feed expands metadata as key/value — it must be an object.
    expect(typeof edit!.metadata).toBe("object");
    expect(edit!.metadata).toMatchObject({ field: "region", after: "Europe" });
  });

  it("does not leak history across tenants", async () => {
    const dimId = await addDimension("TenantDim", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "Secret", "secret", U, T);
    // A different tenant sees nothing for this (table, row).
    const other = await listRecordHistory(dimId, "secret", "some_other_tenant");
    expect(other.entries).toHaveLength(0);
  });
});
