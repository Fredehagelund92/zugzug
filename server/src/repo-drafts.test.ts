process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, test, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun, pgGet } from "./pg.ts";
import { addDimension, addCanonicalOne } from "./repo-canonical.ts";
import { saveDraft, commit, listAllDrafts } from "./repo-drafts.ts";

const T = "test_commit_out";
const U = "u_test_commit";

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
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
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
  for (const tenant of [T1, T2, T_EMPTY]) {
    await pgRun(`DELETE FROM "zugzug_app"."draft" WHERE tenant_id = $1`, [tenant]).catch(() => {});
    await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [tenant]).catch(
      () => {},
    );
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

// ---- commit() fires dimension.committed event ----------------------------

describe("commit() fires dimension.committed event", () => {
  it("writes an outbound_event row with the right shape", async () => {
    const dimId = await addDimension("CommitDim", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "Alpha", undefined, U, T);
    await saveDraft(dimId, "alpha variant", "mapped", "Alpha", "alpha", U, T);
    const result = await commit(dimId, U, T);
    expect(result.committed).toBeGreaterThan(0);

    const evt = await pgGet<{ type: string; payload: unknown }>(
      `SELECT type, payload FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND dim_id = $2 AND type = 'dimension.committed'
        ORDER BY occurred_at DESC LIMIT 1`,
      [T, dimId],
    );
    expect(evt).not.toBeNull();
    expect(evt!.type).toBe("dimension.committed");
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
