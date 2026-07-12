process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun } from "./pg.ts";
import { addDimension, addCanonicalOne } from "./repo-canonical.ts";
import { saveDraft, commit } from "./repo-drafts.ts";
import { listVersions, getSnapshot } from "./repo-versions.ts";

const T = "test_versions_snap";
const U = "u_test_versions";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'VersionTest', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Version Tester', 'v@example.test', 'VT', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."dimension_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
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

describe("commit writes a snapshot", () => {
  it("commit writes a snapshot with the same version as the outbound event", async () => {
    const dimId = await addDimension("SnapDim", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "United States", undefined, U, T);
    await saveDraft(dimId, "usa", "mapped", "United States", "united_states", U, T);
    const res = await commit(dimId, U, T);
    expect(res.committed).toBe(1);
    const versions = await listVersions(dimId, T);
    expect(versions).toHaveLength(1);
    expect(versions[0].kind).toBe("publish");
    expect(versions[0].counts.mappings).toBeGreaterThanOrEqual(1);
    const snap = await getSnapshot(dimId, T, versions[0].version);
    // to_jsonb(t) uses the actual column name (e.g. "snapdim_code"), not a generic "key".
    // Check that the value "united_states" appears in any field of any record.
    expect(
      snap!.records.some((r) => Object.values(r).includes("united_states")),
    ).toBe(true);
    expect(snap!.mappings).toContainEqual({ raw: "usa", targetKey: "united_states" });
  });

  it("version number matches outbound_event count", async () => {
    const dimId = await addDimension("VersionCountDim", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "Beta", undefined, U, T);
    await saveDraft(dimId, "beta raw", "mapped", "Beta", "beta", U, T);
    await commit(dimId, U, T);

    await addCanonicalOne(dimId, "Gamma", undefined, U, T);
    await saveDraft(dimId, "gamma raw", "mapped", "Gamma", "gamma", U, T);
    await commit(dimId, U, T);

    const versions = await listVersions(dimId, T);
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(2); // DESC order — newest first
    expect(versions[1].version).toBe(1);
  });
});
