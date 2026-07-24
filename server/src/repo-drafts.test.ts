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
  addDimension,
  addRecordOne,
  addField,
  setFieldValue,
  deleteDimension,
} from "./repo-record.ts";
import { saveDraft, commit, listDrafts, rejectDrafts, listAllDrafts } from "./repo-drafts.ts";
import { getPreferences, setPreferences } from "./repo-meta.ts";

// Drop each tenant's dimensions through deleteDimension so the physical
// dim_/map_ Postgres tables go too — a plain `DELETE FROM dimension` leaves them
// orphaned, and the next run's CREATE TABLE IF NOT EXISTS reuses stale data.
async function dropDims(tenants: string[]): Promise<void> {
  for (const tenant of tenants) {
    const dims = await pgAll<{ id: string }>(
      `SELECT id FROM "zugzug_app"."dimension" WHERE tenant_id = $1`,
      [tenant],
    ).catch(() => [] as { id: string }[]);
    for (const d of dims) await deleteDimension(d.id, "test-teardown", tenant).catch(() => {});
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

    const dimId = await addDimension("GateDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(dimId, "United States", undefined, U, T);
    // Alice (U) authors the draft
    await saveDraft(dimId, "usa", "mapped", "United States", "united_states", U, T);

    // Alice cannot publish her own draft
    await expect(commit(dimId, U, T)).rejects.toThrow(/another editor must publish/i);

    // Bob (U2) can publish Alice's draft
    const res = await commit(dimId, U2, T);
    expect(res.committed).toBe(1);

    // Reset the preference so other tests are unaffected
    await setPreferences({ ...prefs, requireSecondPublisher: false }, T);
  });
});

describe("commit() required-field gate", () => {
  it("blocks publish when a required field is empty, allows it once filled", async () => {
    const dimId = await addDimension("ReqFieldDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(dimId, "United States", "usa", U, T);
    const added = await addField(dimId, "Region", "text", undefined, { required: true }, U, T);
    expect(added?.field).toBe("region");

    // The record has no region yet — publish is blocked and names the gap.
    await expect(commit(dimId, U, T)).rejects.toThrow(/required value before you can publish/i);

    // Fill the required value; the same publish now goes through.
    await setFieldValue(dimId, "usa", "region", "Americas", U, T);
    await expect(commit(dimId, U, T)).resolves.toBeDefined();
  });

  it("does not block when the required field has a value on every record", async () => {
    const dimId = await addDimension("ReqFieldDim2", [], { keyKind: "slug" }, U, T);
    await addRecordOne(dimId, "Canada", "canada", U, T);
    await addField(dimId, "Region", "text", undefined, { required: true }, U, T);
    await setFieldValue(dimId, "canada", "region", "Americas", U, T);

    await expect(commit(dimId, U, T)).resolves.toBeDefined();
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

  // T1: dim A (2 drafts) + dim B (1 draft)
  const dimA = await addDimension("ListAllDimA", [], { keyKind: "slug" }, U_ALL, T1);
  const dimB = await addDimension("ListAllDimB", [], { keyKind: "slug" }, U_ALL, T1);
  await saveDraft(dimA, "alpha", "mapped", "Alpha", "alpha", U_ALL, T1);
  await saveDraft(dimA, "beta", "skipped", null, null, U_ALL, T1);
  await saveDraft(dimB, "gamma", "mapped", "Gamma", "gamma", U_ALL, T1);

  // T2: dim A (1 draft) — must not bleed into T1 results
  const dimA_t2 = await addDimension("ListAllDimA_T2", [], { keyKind: "slug" }, U_ALL, T2);
  await saveDraft(dimA_t2, "delta", "mapped", "Delta", "delta", U_ALL, T2);

  // Store dim IDs so tests can reference them
  (globalThis as Record<string, unknown>).__listAllDimA = dimA;
  (globalThis as Record<string, unknown>).__listAllDimB = dimB;
  (globalThis as Record<string, unknown>).__listAllDimA_t2 = dimA_t2;
});

afterAll(async () => {
  await dropDims([T1, T2, T_EMPTY]);
  for (const tenant of [T1, T2, T_EMPTY]) {
    await pgRun(`DELETE FROM "zugzug_app"."draft" WHERE tenant_id = $1`, [tenant]).catch(() => {});
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [tenant]).catch(() => {});
  }
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U_ALL]).catch(() => {});
});

test("listAllDrafts returns every dim's drafts for the tenant in one call", async () => {
  const dimA = (globalThis as Record<string, unknown>).__listAllDimA as string;
  const dimB = (globalThis as Record<string, unknown>).__listAllDimB as string;
  const all = await listAllDrafts(T1);
  expect(all.map((d) => d.dimId).sort()).toEqual([dimA, dimA, dimB].sort());
});

test("listAllDrafts is tenant-scoped — a second tenant's drafts never appear", async () => {
  const dimA_t2 = (globalThis as Record<string, unknown>).__listAllDimA_t2 as string;
  const all = await listAllDrafts(T1);
  expect(all.every((d) => d.dimId !== dimA_t2)).toBe(true);
});

test("listAllDrafts returns [] for an empty workspace", async () => {
  expect(await listAllDrafts(T_EMPTY)).toEqual([]);
});

// ---- commit() fires table.published event ----------------------------

describe("commit() fires table.published event", () => {
  it("writes an outbound_event row with the right shape", async () => {
    const dimId = await addDimension("CommitDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(dimId, "Alpha", undefined, U, T);
    await saveDraft(dimId, "alpha variant", "mapped", "Alpha", "alpha", U, T);
    const result = await commit(dimId, U, T);
    expect(result.committed).toBeGreaterThan(0);

    const evt = await pgGet<{ type: string; payload: unknown }>(
      `SELECT type, payload FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND dim_id = $2 AND type = 'table.published'
        ORDER BY occurred_at DESC LIMIT 1`,
      [T, dimId],
    );
    expect(evt).not.toBeNull();
    expect(evt!.type).toBe("table.published");
    const payload =
      typeof evt!.payload === "string"
        ? (JSON.parse(evt!.payload) as Record<string, unknown>)
        : (evt!.payload as Record<string, unknown>);
    expect(payload.dim_slug).toBe(dimId);
    const committedBy = payload.committed_by as { id: string } | undefined;
    expect(committedBy?.id).toBe(U);
  });

  it("does NOT fire when commit() short-circuits (no approved drafts)", async () => {
    const dimId = await addDimension("EmptyCommit", [], { keyKind: "slug" }, U, T);
    const before = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND dim_id = $2`,
      [T, dimId],
    );
    await commit(dimId, U, T); // no drafts → committed=0
    const after = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND dim_id = $2`,
      [T, dimId],
    );
    expect(after!.n).toBe(before!.n);
  });
});

describe("commit() draft-scoped folding", () => {
  const run = Date.now();

  it("commit with draftKeys folds only those drafts", async () => {
    const prefs = await getPreferences(T);
    await setPreferences({ ...prefs, requireSecondPublisher: false }, T);
    const dimId = await addDimension(`ScopedFold_${run}`, [], { keyKind: "slug" }, U, T);
    await addRecordOne(dimId, "United States", undefined, U, T);
    await saveDraft(dimId, "usa", "mapped", "United States", "united_states", U, T);
    await saveDraft(dimId, "u.s.", "mapped", "United States", "united_states", U, T);
    const res = await commit(dimId, U, T, ["usa"]);
    expect(res.committed).toBe(1);
    const remaining = await listDrafts(dimId, T);
    expect(remaining.map((d) => d.raw)).toEqual(["u.s."]);
  });

  it("commit with an unknown draft key folds nothing and throws", async () => {
    const prefs = await getPreferences(T);
    await setPreferences({ ...prefs, requireSecondPublisher: false }, T);
    const dimId = await addDimension(`UnknownKey_${run}`, [], { keyKind: "slug" }, U, T);
    await addRecordOne(dimId, "United States", undefined, U, T);
    await saveDraft(dimId, "usa", "mapped", "United States", "united_states", U, T);
    await expect(commit(dimId, U, T, ["usa", "ghost"])).rejects.toThrow(/ghost/);
    expect((await listDrafts(dimId, T)).length).toBe(1);
  });

  it("four-eyes gate checks only the folded set", async () => {
    await setPreferences({ ...(await getPreferences(T)), requireSecondPublisher: true }, T);
    const dimId = await addDimension(`FourEyesScoped_${run}`, [], { keyKind: "slug" }, U, T);
    await addRecordOne(dimId, "A", undefined, U, T);
    await addRecordOne(dimId, "B", undefined, U, T);
    await saveDraft(dimId, "aaa", "mapped", "A", "a", U, T); // U's draft
    await saveDraft(dimId, "bbb", "mapped", "B", "b", U2, T); // U2's draft
    await expect(commit(dimId, U, T, ["bbb"])).resolves.toMatchObject({ committed: 1 }); // U publishes U2's — fine
    await expect(commit(dimId, U, T, ["aaa"])).rejects.toThrow(/another editor must publish/i); // U can't publish own
    await setPreferences({ ...(await getPreferences(T)), requireSecondPublisher: false }, T);
  });

  it("empty draftKeys folds nothing but publishes when record changed", async () => {
    const prefs = await getPreferences(T);
    await setPreferences({ ...prefs, requireSecondPublisher: false }, T);
    const dimId = await addDimension(`EmptyArrayScope_${run}`, [], { keyKind: "slug" }, U, T);
    await addRecordOne(dimId, "Alpha", undefined, U, T);

    // Stage a draft and commit it (v1)
    await saveDraft(dimId, "alpha variant", "mapped", "Alpha", "alpha", U, T);
    await commit(dimId, U, T);

    // Make a record change since last publish
    await addRecordOne(dimId, "Beta", undefined, U, T);

    // Stage another draft
    await saveDraft(dimId, "beta variant", "mapped", "Beta", "beta", U, T);

    // Count versions before
    const versionsBefore = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
       WHERE tenant_id = $1 AND dim_id = $2 AND type = 'table.published'`,
      [T, dimId],
    );

    // Commit with empty array — folds no drafts but publishes (record changed)
    const res = await commit(dimId, U, T, []);
    expect(res.committed).toBe(0);

    // New draft must still be staged
    const remaining = await listDrafts(dimId, T);
    expect(remaining.map((d) => d.raw)).toContain("beta variant");

    // A new version must have been created
    const versionsAfter = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
       WHERE tenant_id = $1 AND dim_id = $2 AND type = 'table.published'`,
      [T, dimId],
    );
    expect(versionsAfter!.n).toBe(versionsBefore!.n + 1);
  });
});

describe("commit() manual ordering mode", () => {
  const run = Date.now();

  it("scoped commit inserts dim row with position for the folded draft only", async () => {
    const prefs = await getPreferences(T);
    await setPreferences({ ...prefs, requireSecondPublisher: false }, T);
    const dimId = await addDimension(`ManualOrdering_${run}`, [], { keyKind: "slug" }, U, T);

    // Switch to manual ordering mode via SQL UPDATE
    await pgRun(
      `UPDATE "zugzug_app"."dimension" SET ordering_mode = 'manual' WHERE id = $1 AND tenant_id = $2`,
      [dimId, T],
    );

    // Stage two drafts with new target keys (not yet in the dim table)
    await saveDraft(dimId, "foo raw", "mapped", "Foo", "foo", U, T);
    await saveDraft(dimId, "bar raw", "mapped", "Bar", "bar", U, T);

    // Commit scoped to only "foo raw"
    const res = await commit(dimId, U, T, ["foo raw"]);
    expect(res.committed).toBe(1);

    // Look up the dim table name and key column from the dimension registry
    const dimMeta = await pgGet<{ dimTable: string; keyCol: string }>(
      `SELECT dim_table AS "dimTable", key_col AS "keyCol"
       FROM "zugzug_app"."dimension" WHERE id = $1 AND tenant_id = $2`,
      [dimId, T],
    );

    // "foo" should be in the dim table with a non-null position
    const fooRow = await pgGet<{ position: number | null }>(
      `SELECT position FROM ${dimMeta!.dimTable} WHERE ${dimMeta!.keyCol} = $1`,
      ["foo"],
    );
    expect(fooRow).not.toBeNull();
    expect(fooRow!.position).not.toBeNull();
    expect(Number(fooRow!.position)).toBeGreaterThan(0);

    // "bar raw" draft must still be staged
    const remaining = await listDrafts(dimId, T);
    expect(remaining.map((d) => d.raw)).toContain("bar raw");
  });
});

describe("rejectDrafts()", () => {
  it("reject sets status, reason, reviewer; re-staging clears them", async () => {
    const dimId = await addDimension("RejectDim", [], { keyKind: "slug" }, U, T);
    await saveDraft(dimId, "usa", "mapped", "United States", "united_states", U, T);
    const r = await rejectDrafts(
      dimId,
      T,
      ["usa"],
      "wrong target — USA is a country not a partner",
      U2,
    );
    expect(r.rejected).toBe(1);
    const [d] = await listDrafts(dimId, T);
    expect(d.status).toBe("rejected");
    expect(d.rejectedReason).toMatch(/wrong target/);
    await saveDraft(dimId, "usa", "mapped", "United States of America", "united_states", U, T); // re-stage
    const [d2] = await listDrafts(dimId, T);
    expect(d2.status).toBe("mapped");
    expect(d2.rejectedReason).toBeNull();
  });
  it("reject with empty reason 400s", async () => {
    const dimId = await addDimension("RejectEmptyReason", [], { keyKind: "slug" }, U, T);
    await expect(rejectDrafts(dimId, T, ["usa"], "  ", U2)).rejects.toThrow(/reason/i);
  });
});
