process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun, pgGet } from "./pg.ts";
import { addDimension, addCanonicalOne } from "./repo-canonical.ts";
import { saveDraft, commit } from "./repo-drafts.ts";

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
