process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import {
  addDimension,
  addCanonicalOne,
  mergeCanonical,
  retireCanonical,
} from "./repo-canonical.ts";

const T = "t_outbound_sd";
const DIM_NAME = "Outbound SD Country";
const DIM_ID = "outbound_sd_country";
const RETIRE_DIM_NAME = "Outbound SD Retire";
const RETIRE_DIM_ID = "outbound_sd_retire";
const USER_ID = "u_outbound_sd";

beforeAll(async () => {
  // Clean any prior run.
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."dim_${DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."map_${DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."dim_${RETIRE_DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."map_${RETIRE_DIM_ID}"`).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [USER_ID]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});

  // Seed tenant + user (audit_log FKs users).
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $1, 'Outbound SD', 'default', now())`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, email, name, initials)
     VALUES ($1, 'outbound-sd@example.com', 'Outbound SD', 'OS')
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."dim_${DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."map_${DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."dim_${RETIRE_DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."map_${RETIRE_DIM_ID}"`).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [USER_ID]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("mergeCanonical soft-deletes the loser's canonical_version", () => {
  it("retired_at + retired_into are populated on loser rows; survivor stays live", async () => {
    // Fresh dimension owned by our test tenant.
    const dimId = await addDimension(DIM_NAME, [], {}, USER_ID, T);
    expect(dimId).toBe(DIM_ID);

    // Seed survivor + loser. addCanonicalOne writes the canonical_version row too.
    await addCanonicalOne(dimId, "United States", "us", USER_ID, T);
    await addCanonicalOne(dimId, "USA Alias", "usa", USER_ID, T);

    // Grab current versions for the optimistic-concurrency check.
    const versions = await pgAll<{ key: string; version: number }>(
      `SELECT key, version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2`,
      [dimId, T],
    );
    const expected: Record<string, number> = {};
    for (const v of versions) expected[v.key] = v.version;
    expect(expected.us).toBeDefined();
    expect(expected.usa).toBeDefined();

    // Merge: "usa" → "us".
    const merged = await mergeCanonical(dimId, "us", ["usa"], USER_ID, expected, T);
    expect(merged).toBe(1);

    // Loser row PERSISTS with retired_at + retired_into set.
    const loser = await pgGet<{
      key: string;
      retired_at: Date | null;
      retired_into: string | null;
    }>(
      `SELECT key, retired_at, retired_into FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'usa'`,
      [dimId, T],
    );
    expect(loser).not.toBeNull();
    expect(loser!.retired_at).not.toBeNull();
    expect(loser!.retired_into).toBe("us");

    // Survivor row stays live.
    const survivor = await pgGet<{
      key: string;
      retired_at: Date | null;
      retired_into: string | null;
    }>(
      `SELECT key, retired_at, retired_into FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'us'`,
      [dimId, T],
    );
    expect(survivor).not.toBeNull();
    expect(survivor!.retired_at).toBeNull();
    expect(survivor!.retired_into).toBeNull();
  });
});

describe("retireCanonical soft-deletes the canonical_version row", () => {
  it("retired_at is set, retired_into stays null (no merge target)", async () => {
    const dimId = await addDimension(RETIRE_DIM_NAME, [], {}, USER_ID, T);
    expect(dimId).toBe(RETIRE_DIM_ID);

    await addCanonicalOne(dimId, "X One", "x1", USER_ID, T);

    const before = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'x1'`,
      [dimId, T],
    );
    expect(before).not.toBeNull();

    const result = await retireCanonical(dimId, "x1", USER_ID, before!.version, T);
    expect(result.ok).toBe(true);

    const after = await pgGet<{
      key: string;
      retired_at: Date | null;
      retired_into: string | null;
    }>(
      `SELECT key, retired_at, retired_into FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'x1'`,
      [dimId, T],
    );
    expect(after).not.toBeNull();
    expect(after!.retired_at).not.toBeNull();
    expect(after!.retired_into).toBeNull();
  });
});
