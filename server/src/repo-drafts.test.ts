process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, test, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun, pgGet } from "./pg.ts";
import { pgAll } from "./repo-shared.ts";
import {
  addRefTable,
  addRecordOne,
  addField,
  setFieldValue,
  deleteRefTable,
} from "./repo-record.ts";
import { saveDraft, commit, listDrafts, rejectDrafts, listAllDrafts } from "./repo-drafts.ts";
import { getPreferences, setPreferences } from "./repo-meta.ts";

// Drop each tenant's refTables through deleteRefTable so the physical
// dim_/map_ Postgres tables go too — a plain `DELETE FROM refTable` leaves them
// orphaned, and the next run's CREATE TABLE IF NOT EXISTS reuses stale data.
async function dropDims(tenants: string[]): Promise<void> {
  for (const tenant of tenants) {
    const refTables = await pgAll<{ id: string }>(
      `SELECT id FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`,
      [tenant],
    ).catch(() => [] as { id: string }[]);
    for (const d of refTables) await deleteRefTable(d.id, "test-teardown", tenant).catch(() => {});
  }
}

const T = "test_commit_out";
const U = "u_test_commit";
const U2 = "u_test_commit_bob";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'Sweep', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Commit Tester', 'c@example.test', 'CT', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Bob Publisher', 'bob@example.test', 'BP', false)
     ON CONFLICT DO NOTHING`,
    [U2],
  );
});

afterAll(async () => {
  await dropDims([T]);
  await pgRun(`DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U2]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("commit() second-publisher gate", () => {
  it("rejects self-publish when requireSecondPublisher is on", async () => {
    const prefs = await getPreferences(T);
    await setPreferences({ ...prefs, requireSecondPublisher: true }, T);

    const refTableId = await addRefTable("GateDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "United States", undefined, U, T);
    // Alice (U) authors the draft
    await saveDraft(refTableId, "usa", "mapped", "United States", "united_states", U, T);

    // Alice cannot publish her own draft
    await expect(commit(refTableId, U, T)).rejects.toThrow(/another editor must publish/i);

    // Bob (U2) can publish Alice's draft
    const res = await commit(refTableId, U2, T);
    expect(res.committed).toBe(1);

    // Reset the preference so other tests are unaffected
    await setPreferences({ ...prefs, requireSecondPublisher: false }, T);
  });
});

describe("commit() required-field gate", () => {
  it("blocks publish when a required field is empty, allows it once filled", async () => {
    const refTableId = await addRefTable("ReqFieldDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "United States", "usa", U, T);
    const added = await addField(refTableId, "Region", "text", undefined, { required: true }, U, T);
    expect(added?.field).toBe("region");

    // The record has no region yet — publish is blocked and names the gap.
    await expect(commit(refTableId, U, T)).rejects.toThrow(
      /required value before you can publish/i,
    );

    // Fill the required value; the same publish now goes through.
    await setFieldValue(refTableId, "usa", "region", "Americas", U, T);
    await expect(commit(refTableId, U, T)).resolves.toBeDefined();
  });

  it("does not block when the required field has a value on every record", async () => {
    const refTableId = await addRefTable("ReqFieldDim2", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Canada", "canada", U, T);
    await addField(refTableId, "Region", "text", undefined, { required: true }, U, T);
    await setFieldValue(refTableId, "canada", "region", "Americas", U, T);

    await expect(commit(refTableId, U, T)).resolves.toBeDefined();
  });
});

// ---- listAllDrafts -------------------------------------------------------

const T1 = "test_list_all_t1";
const T2 = "test_list_all_t2";
const T_EMPTY = "test_list_all_empty";
const U_ALL = "u_list_all_drafts";

beforeAll(async () => {
  for (const tenant of [T1, T2, T_EMPTY]) {
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
       VALUES ($1, $1, 'ListAll', now()) ON CONFLICT DO NOTHING`,
      [tenant],
    );
  }
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'ListAll User', 'la@example.test', 'LA', false)
     ON CONFLICT DO NOTHING`,
    [U_ALL],
  );

  // T1: refTable A (2 drafts) + refTable B (1 draft)
  const refTableA = await addRefTable("ListAllRefTableA", [], { keyKind: "slug" }, U_ALL, T1);
  const refTableB = await addRefTable("ListAllRefTableB", [], { keyKind: "slug" }, U_ALL, T1);
  await saveDraft(refTableA, "alpha", "mapped", "Alpha", "alpha", U_ALL, T1);
  await saveDraft(refTableA, "beta", "skipped", null, null, U_ALL, T1);
  await saveDraft(refTableB, "gamma", "mapped", "Gamma", "gamma", U_ALL, T1);

  // T2: refTable A (1 draft) — must not bleed into T1 results
  const refTableA_t2 = await addRefTable("ListAllRefTableA_T2", [], { keyKind: "slug" }, U_ALL, T2);
  await saveDraft(refTableA_t2, "delta", "mapped", "Delta", "delta", U_ALL, T2);

  // Store refTable IDs so tests can reference them
  (globalThis as Record<string, unknown>).__listAllRefTableA = refTableA;
  (globalThis as Record<string, unknown>).__listAllRefTableB = refTableB;
  (globalThis as Record<string, unknown>).__listAllRefTableA_t2 = refTableA_t2;
});

afterAll(async () => {
  await dropDims([T1, T2, T_EMPTY]);
  for (const tenant of [T1, T2, T_EMPTY]) {
    await pgRun(`DELETE FROM "zugzug_app"."draft" WHERE tenant_id = $1`, [tenant]).catch(() => {});
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [tenant]).catch(() => {});
  }
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U_ALL]).catch(() => {});
});

test("listAllDrafts returns every refTable's drafts for the tenant in one call", async () => {
  const refTableA = (globalThis as Record<string, unknown>).__listAllRefTableA as string;
  const refTableB = (globalThis as Record<string, unknown>).__listAllRefTableB as string;
  const all = await listAllDrafts(T1);
  expect(all.map((d) => d.refTableId).sort()).toEqual([refTableA, refTableA, refTableB].sort());
});

test("listAllDrafts is tenant-scoped — a second tenant's drafts never appear", async () => {
  const refTableA_t2 = (globalThis as Record<string, unknown>).__listAllRefTableA_t2 as string;
  const all = await listAllDrafts(T1);
  expect(all.every((d) => d.refTableId !== refTableA_t2)).toBe(true);
});

test("listAllDrafts returns [] for an empty workspace", async () => {
  expect(await listAllDrafts(T_EMPTY)).toEqual([]);
});

// ---- commit() fires table.published event ----------------------------

describe("commit() fires table.published event", () => {
  it("writes an outbound_event row with the right shape", async () => {
    const refTableId = await addRefTable("CommitDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Alpha", undefined, U, T);
    await saveDraft(refTableId, "alpha variant", "mapped", "Alpha", "alpha", U, T);
    const result = await commit(refTableId, U, T);
    expect(result.committed).toBeGreaterThan(0);

    const evt = await pgGet<{ type: string; payload: unknown }>(
      `SELECT type, payload FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND reference_table_id = $2 AND type = 'table.published'
        ORDER BY occurred_at DESC LIMIT 1`,
      [T, refTableId],
    );
    expect(evt).not.toBeNull();
    expect(evt!.type).toBe("table.published");
    const payload =
      typeof evt!.payload === "string"
        ? (JSON.parse(evt!.payload) as Record<string, unknown>)
        : (evt!.payload as Record<string, unknown>);
    expect(payload.dim_slug).toBe(refTableId);
    const committedBy = payload.committed_by as { id: string } | undefined;
    expect(committedBy?.id).toBe(U);
  });

  it("does NOT fire when commit() short-circuits (no approved drafts)", async () => {
    const refTableId = await addRefTable("EmptyCommit", [], { keyKind: "slug" }, U, T);
    const before = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND reference_table_id = $2`,
      [T, refTableId],
    );
    await commit(refTableId, U, T); // no drafts → committed=0
    const after = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND reference_table_id = $2`,
      [T, refTableId],
    );
    expect(after!.n).toBe(before!.n);
  });
});

describe("commit() draft-scoped folding", () => {
  const run = Date.now();

  it("commit with draftKeys folds only those drafts", async () => {
    const prefs = await getPreferences(T);
    await setPreferences({ ...prefs, requireSecondPublisher: false }, T);
    const refTableId = await addRefTable(`ScopedFold_${run}`, [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "United States", undefined, U, T);
    await saveDraft(refTableId, "usa", "mapped", "United States", "united_states", U, T);
    await saveDraft(refTableId, "u.s.", "mapped", "United States", "united_states", U, T);
    const res = await commit(refTableId, U, T, ["usa"]);
    expect(res.committed).toBe(1);
    const remaining = await listDrafts(refTableId, T);
    expect(remaining.map((d) => d.raw)).toEqual(["u.s."]);
  });

  it("commit with an unknown draft key folds nothing and throws", async () => {
    const prefs = await getPreferences(T);
    await setPreferences({ ...prefs, requireSecondPublisher: false }, T);
    const refTableId = await addRefTable(`UnknownKey_${run}`, [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "United States", undefined, U, T);
    await saveDraft(refTableId, "usa", "mapped", "United States", "united_states", U, T);
    await expect(commit(refTableId, U, T, ["usa", "ghost"])).rejects.toThrow(/ghost/);
    expect((await listDrafts(refTableId, T)).length).toBe(1);
  });

  it("four-eyes gate checks only the folded set", async () => {
    await setPreferences({ ...(await getPreferences(T)), requireSecondPublisher: true }, T);
    const refTableId = await addRefTable(`FourEyesScoped_${run}`, [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "A", undefined, U, T);
    await addRecordOne(refTableId, "B", undefined, U, T);
    await saveDraft(refTableId, "aaa", "mapped", "A", "a", U, T); // U's draft
    await saveDraft(refTableId, "bbb", "mapped", "B", "b", U2, T); // U2's draft
    await expect(commit(refTableId, U, T, ["bbb"])).resolves.toMatchObject({ committed: 1 }); // U publishes U2's — fine
    await expect(commit(refTableId, U, T, ["aaa"])).rejects.toThrow(/another editor must publish/i); // U can't publish own
    await setPreferences({ ...(await getPreferences(T)), requireSecondPublisher: false }, T);
  });

  it("empty draftKeys folds nothing but publishes when record changed", async () => {
    const prefs = await getPreferences(T);
    await setPreferences({ ...prefs, requireSecondPublisher: false }, T);
    const refTableId = await addRefTable(`EmptyArrayScope_${run}`, [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Alpha", undefined, U, T);

    // Stage a draft and commit it (v1)
    await saveDraft(refTableId, "alpha variant", "mapped", "Alpha", "alpha", U, T);
    await commit(refTableId, U, T);

    // Make a record change since last publish
    await addRecordOne(refTableId, "Beta", undefined, U, T);

    // Stage another draft
    await saveDraft(refTableId, "beta variant", "mapped", "Beta", "beta", U, T);

    // Count versions before
    const versionsBefore = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
       WHERE tenant_id = $1 AND reference_table_id = $2 AND type = 'table.published'`,
      [T, refTableId],
    );

    // Commit with empty array — folds no drafts but publishes (record changed)
    const res = await commit(refTableId, U, T, []);
    expect(res.committed).toBe(0);

    // New draft must still be staged
    const remaining = await listDrafts(refTableId, T);
    expect(remaining.map((d) => d.raw)).toContain("beta variant");

    // A new version must have been created
    const versionsAfter = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
       WHERE tenant_id = $1 AND reference_table_id = $2 AND type = 'table.published'`,
      [T, refTableId],
    );
    expect(versionsAfter!.n).toBe(versionsBefore!.n + 1);
  });
});

describe("commit() manual ordering mode", () => {
  const run = Date.now();

  it("scoped commit inserts refTable row with position for the folded draft only", async () => {
    const prefs = await getPreferences(T);
    await setPreferences({ ...prefs, requireSecondPublisher: false }, T);
    const refTableId = await addRefTable(`ManualOrdering_${run}`, [], { keyKind: "slug" }, U, T);

    // Switch to manual ordering mode via SQL UPDATE
    await pgRun(
      `UPDATE "zugzug_app"."reference_table" SET ordering_mode = 'manual' WHERE id = $1 AND tenant_id = $2`,
      [refTableId, T],
    );

    // Stage two drafts with new target keys (not yet in the refTable table)
    await saveDraft(refTableId, "foo raw", "mapped", "Foo", "foo", U, T);
    await saveDraft(refTableId, "bar raw", "mapped", "Bar", "bar", U, T);

    // Commit scoped to only "foo raw"
    const res = await commit(refTableId, U, T, ["foo raw"]);
    expect(res.committed).toBe(1);

    // Look up the refTable table name and key column from the refTable registry
    const refTableMeta = await pgGet<{ dimTable: string; keyCol: string }>(
      `SELECT dim_table AS "dimTable", key_col AS "keyCol"
       FROM "zugzug_app"."reference_table" WHERE id = $1 AND tenant_id = $2`,
      [refTableId, T],
    );

    // "foo" should be in the refTable table with a non-null position
    const fooRow = await pgGet<{ position: number | null }>(
      `SELECT position FROM ${refTableMeta!.dimTable} WHERE ${refTableMeta!.keyCol} = $1`,
      ["foo"],
    );
    expect(fooRow).not.toBeNull();
    expect(fooRow!.position).not.toBeNull();
    expect(Number(fooRow!.position)).toBeGreaterThan(0);

    // "bar raw" draft must still be staged
    const remaining = await listDrafts(refTableId, T);
    expect(remaining.map((d) => d.raw)).toContain("bar raw");
  });
});

describe("rejectDrafts()", () => {
  it("reject sets status, reason, reviewer; re-staging clears them", async () => {
    const refTableId = await addRefTable("RejectDim", [], { keyKind: "slug" }, U, T);
    await saveDraft(refTableId, "usa", "mapped", "United States", "united_states", U, T);
    const r = await rejectDrafts(
      refTableId,
      T,
      ["usa"],
      "wrong target — USA is a country not a partner",
      U2,
    );
    expect(r.rejected).toBe(1);
    const [d] = await listDrafts(refTableId, T);
    expect(d.status).toBe("rejected");
    expect(d.rejectedReason).toMatch(/wrong target/);
    await saveDraft(refTableId, "usa", "mapped", "United States of America", "united_states", U, T); // re-stage
    const [d2] = await listDrafts(refTableId, T);
    expect(d2.status).toBe("mapped");
    expect(d2.rejectedReason).toBeNull();
  });
  it("reject with empty reason 400s", async () => {
    const refTableId = await addRefTable("RejectEmptyReason", [], { keyKind: "slug" }, U, T);
    await expect(rejectDrafts(refTableId, T, ["usa"], "  ", U2)).rejects.toThrow(/reason/i);
  });
});

// ---- #150: concurrent-publish version race ---------------------------
describe("commit() concurrent publish (#150)", () => {
  it("two concurrent commits on one table both succeed with distinct versions", async () => {
    const run = crypto.randomUUID().slice(0, 8);
    const refTableId = await addRefTable(`ConcPublish_${run}`, [], { keyKind: "slug" }, U, T);
    await saveDraft(refTableId, "aaa", "mapped", "Aaa", "aaa", U, T);
    await saveDraft(refTableId, "bbb", "mapped", "Bbb", "bbb", U2, T);

    // Cross-publish so the four-eyes gate passes whether or not it is enabled:
    // each committer folds the *other* user's draft. Without version-assignment
    // serialization these two transactions can both compute the same next
    // version and one rolls back on the unique index.
    const [r1, r2] = await Promise.all([
      commit(refTableId, U, T, ["bbb"]),
      commit(refTableId, U2, T, ["aaa"]),
    ]);
    expect(r1.committed).toBe(1);
    expect(r2.committed).toBe(1);

    const versions = await pgAll<{ version: number }>(
      `SELECT version FROM "zugzug_app"."reference_table_version"
        WHERE reference_table_id = $1 AND tenant_id = $2 ORDER BY version`,
      [refTableId, T],
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });
});
