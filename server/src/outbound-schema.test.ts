process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet, pgAll } from "./pg.ts";
import {
  addDimension,
  addCanonicalOne,
  mergeCanonical,
  retireCanonical,
  renameCanonical,
} from "./repo-canonical.ts";
import { teardownTenant } from "./tenant.ts";

const T = "t_outbound_sd";
const DIM_NAME = "Outbound SD Country";
const DIM_ID = "outbound_sd_country";
const RETIRE_DIM_NAME = "Outbound SD Retire";
const RETIRE_DIM_ID = "outbound_sd_retire";
const GHOST_DIM_NAME = "Outbound SD Ghost";
const GHOST_DIM_ID = "outbound_sd_ghost";
const READD_DIM_NAME = "Outbound SD Readd";
const READD_DIM_ID = "outbound_sd_readd";
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
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."dim_${GHOST_DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."map_${GHOST_DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."dim_${READD_DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."map_${READD_DIM_ID}"`).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [USER_ID]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});

  // Seed tenant + user (audit_log FKs users).
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'Outbound SD', now())`,
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
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."dim_${GHOST_DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."map_${GHOST_DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."dim_${READD_DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."map_${READD_DIM_ID}"`).catch(() => {});
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

describe("retired rows do not appear in canonical listings", () => {
  it("after merge, version-lookup SELECT returns survivor only — no ghost row", async () => {
    const dimId = await addDimension(GHOST_DIM_NAME, [], {}, USER_ID, T);
    expect(dimId).toBe(GHOST_DIM_ID);

    await addCanonicalOne(dimId, "Alpha", "a", USER_ID, T);
    await addCanonicalOne(dimId, "Bravo", "b", USER_ID, T);

    // Read versions exactly like the edit path does (must include both before merge).
    const before = await pgAll<{ key: string; version: number }>(
      `SELECT key, version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND retired_at IS NULL
        ORDER BY key`,
      [dimId, T],
    );
    expect(before.map((r) => r.key)).toEqual(["a", "b"]);

    const expected: Record<string, number> = {};
    for (const v of before) expected[v.key] = v.version;

    // Merge: "b" → "a".
    const merged = await mergeCanonical(dimId, "a", ["b"], USER_ID, expected, T);
    expect(merged).toBe(1);

    // Sanity: tombstone still exists in raw table (i.e. the test isn't accidentally hard-deleting).
    const raw = await pgAll<{ key: string }>(
      `SELECT key FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2
        ORDER BY key`,
      [dimId, T],
    );
    expect(raw.map((r) => r.key)).toEqual(["a", "b"]);

    // The tombstone must NOT be bump-able via the optimistic-concurrency UPDATE
    // (bumpVersionOrThrow). Look up the tombstone's CURRENT version (merge bumped
    // it once before retiring), then try to rename with that exact version. Without
    // `AND retired_at IS NULL` on the UPDATE, this would silently succeed and
    // re-bump the tombstone — resurrecting the row. With the filter, this throws.
    const tomb = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'b'`,
      [dimId, T],
    );
    expect(tomb).not.toBeNull();
    const tombstoneVersion = tomb!.version;

    let threw = false;
    try {
      await renameCanonical(dimId, "b", "Resurrected", USER_ID, tombstoneVersion, T);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // And the tombstone's version is unchanged (no silent bump).
    const stillTomb = await pgGet<{ version: number; retired_at: Date | null }>(
      `SELECT version, retired_at FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'b'`,
      [dimId, T],
    );
    expect(stillTomb).not.toBeNull();
    expect(stillTomb!.retired_at).not.toBeNull();
    expect(stillTomb!.version).toBe(tombstoneVersion);
  });
});

describe("re-adding a previously-retired key un-tombstones the canonical_version", () => {
  it("after retire(X) then addCanonicalOne(X), the row is visible with version > 1", async () => {
    // Defensive: addDimension's existence check is unscoped (dim ids are globally
    // unique), so a stale row from a different tenant would make it skip the
    // CREATE TABLE for dim_/map_. Clear any prior registry row for this id.
    await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE id = $1`, [READD_DIM_ID]).catch(
      () => {},
    );
    const dimId = await addDimension(READD_DIM_NAME, [], {}, USER_ID, T);
    expect(dimId).toBe(READD_DIM_ID);

    await addCanonicalOne(dimId, "Phoenix", "phoenix", USER_ID, T);

    const v1Row = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'phoenix'`,
      [dimId, T],
    );
    expect(v1Row).not.toBeNull();
    const v1 = v1Row!.version;

    const retired = await retireCanonical(dimId, "phoenix", USER_ID, v1, T);
    expect(retired.ok).toBe(true);

    const tomb = await pgGet<{ retired_at: Date | null; version: number }>(
      `SELECT retired_at, version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'phoenix'`,
      [dimId, T],
    );
    expect(tomb).not.toBeNull();
    expect(tomb!.retired_at).not.toBeNull();

    // Re-add — should un-tombstone the canonical_version row.
    await addCanonicalOne(dimId, "Phoenix", "phoenix", USER_ID, T);

    const after = await pgGet<{
      retired_at: Date | null;
      retired_into: string | null;
      version: number;
    }>(
      `SELECT retired_at, retired_into, version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'phoenix'`,
      [dimId, T],
    );
    expect(after).not.toBeNull();
    expect(after!.retired_at).toBeNull();
    expect(after!.retired_into).toBeNull();
    expect(after!.version).toBeGreaterThan(v1);

    // Visible through the same SELECT the edit path uses (retired_at IS NULL filter).
    const visible = await pgGet<{ key: string; version: number }>(
      `SELECT key, version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'phoenix' AND retired_at IS NULL`,
      [dimId, T],
    );
    expect(visible).not.toBeNull();
    expect(visible!.version).toBeGreaterThan(v1);
  });
});

describe("teardownTenant cleans up outbound integration tables", () => {
  const TT = "t_teardown_outbound";

  it("DELETEs rows from service_account, webhook, outbound_event, webhook_delivery", async () => {
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [TT]).catch(() => {});
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
       VALUES ($1, $1, 'Test Teardown', now())`,
      [TT],
    );

    // Seed one row in each new table.
    await pgRun(
      `INSERT INTO "zugzug_app"."service_account"
         (id, tenant_id, name, token_hash, token_prefix, created_at, created_by)
       VALUES ('sa_test_td', $1, 'x', 'hash', 'zzsa_aaaa11', now(), 'u_test')`,
      [TT],
    );
    await pgRun(
      `INSERT INTO "zugzug_app"."webhook"
         (id, tenant_id, url, secret_ciphertext, secret_nonce, secret_prefix,
          events, created_at, created_by)
       VALUES ('wh_test_td', $1, 'https://example.test/', '\\x00'::bytea, '\\x00'::bytea,
               'whsec_aaaaaa', ARRAY['dimension.committed'], now(), 'u_test')`,
      [TT],
    );
    await pgRun(
      `INSERT INTO "zugzug_app"."outbound_event"
         (id, tenant_id, type, occurred_at, payload, idem_key)
       VALUES ('evt_test_td', $1, 'dimension.committed', now(), '{}'::jsonb, 'k_test_td')`,
      [TT],
    );
    await pgRun(
      `INSERT INTO "zugzug_app"."webhook_delivery"
         (id, tenant_id, webhook_id, event_id, event_type, delivery_url,
          signing_kid, status, payload, signature, created_at)
       VALUES ('whd_test_td', $1, 'wh_test_td', 'evt_test_td', 'dimension.committed',
               'https://example.test/', 'current', 'pending', '{}'::jsonb,
               't=1,v1=sha256=00', now())`,
      [TT],
    );

    await teardownTenant(TT);

    for (const tab of ["service_account", "webhook", "outbound_event", "webhook_delivery"]) {
      const left = await pgGet<{ n: number }>(
        `SELECT count(*)::int AS n FROM "zugzug_app"."${tab}" WHERE tenant_id = $1`,
        [TT],
      );
      expect(left!.n).toBe(0);
    }
  });
});

describe("retireCanonical fires canonical.deleted outbound event inside the tx", () => {
  const DEL_DIM_NAME = "Outbound SD Delete";
  const DEL_DIM_ID = "outbound_sd_delete";
  const REF_DIM_NAME = "Outbound SD Refuse";
  const REF_DIM_ID = "outbound_sd_refuse";

  async function cleanup() {
    await pgRun(
      `DELETE FROM "zugzug_app"."outbound_event" WHERE tenant_id = $1 AND type = 'canonical.deleted'`,
      [T],
    ).catch(() => {});
    for (const id of [DEL_DIM_ID, REF_DIM_ID]) {
      await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE dim_id = $1`, [id]).catch(
        () => {},
      );
      await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE dim_id = $1`, [id]).catch(
        () => {},
      );
      await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE id = $1`, [id]).catch(() => {});
      // dim_/map_ live in the canonical schema ("zugzug"), not the app schema.
      await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${id}"`).catch(() => {});
      await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${id}"`).catch(() => {});
      await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."dim_${id}"`).catch(() => {});
      await pgRun(`DROP TABLE IF EXISTS "zugzug_app"."map_${id}"`).catch(() => {});
    }
  }

  it("writes outbound_event with dim_slug/key/label/deleted_by when retire succeeds", async () => {
    await cleanup();
    const dimId = await addDimension(DEL_DIM_NAME, [], {}, USER_ID, T);
    expect(dimId).toBe(DEL_DIM_ID);

    // addCanonicalOne(label="Beta") → slug() lowercases to key "beta".
    await addCanonicalOne(dimId, "Beta", undefined, USER_ID, T);

    const v = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'beta'`,
      [dimId, T],
    );
    expect(v).not.toBeNull();

    const result = await retireCanonical(dimId, "beta", USER_ID, v!.version, T);
    expect(result.ok).toBe(true);

    const evt = await pgGet<{
      type: string;
      dim_id: string | null;
      payload: unknown;
      idem_key: string;
    }>(
      `SELECT type, dim_id, payload, idem_key FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND type = 'canonical.deleted' AND dim_id = $2`,
      [T, dimId],
    );
    expect(evt).not.toBeNull();
    expect(evt!.type).toBe("canonical.deleted");
    expect(evt!.dim_id).toBe(dimId);
    expect(evt!.idem_key.startsWith(`canonical.deleted:${dimId}:beta:`)).toBe(true);

    const payload =
      typeof evt!.payload === "string"
        ? (JSON.parse(evt!.payload) as Record<string, unknown>)
        : (evt!.payload as Record<string, unknown>);
    expect(payload.dim_slug).toBe(dimId);
    expect(payload.key).toBe("beta");
    expect(payload.label).toBe("Beta");
    const deletedBy = payload.deleted_by as { id: string } | undefined;
    expect(deletedBy?.id).toBe(USER_ID);

    await cleanup();
  });

  it("does NOT write an outbound_event when retire is refused due to live variants", async () => {
    await cleanup();
    const dimId = await addDimension(REF_DIM_NAME, [], {}, USER_ID, T);
    expect(dimId).toBe(REF_DIM_ID);

    await addCanonicalOne(dimId, "Gamma", undefined, USER_ID, T);

    const m = await pgGet<{ map_table: string; key_col: string }>(
      `SELECT map_table, key_col FROM "zugzug_app"."dimension"
        WHERE id = $1 AND tenant_id = $2`,
      [dimId, T],
    );
    expect(m).not.toBeNull();

    // Seed a raw variant pointing at "gamma" so retire refuses.
    // m.map_table is schema-qualified, e.g. "zugzug_app.map_outbound_sd_refuse".
    const [schemaName, tableName] = m!.map_table.split(".");
    await pgRun(
      `INSERT INTO "${schemaName}"."${tableName}" (raw, "${m!.key_col}", tenant_id)
       VALUES ($1, $2, $3)`,
      ["g-raw", "gamma", T],
    );

    const v = await pgGet<{ version: number }>(
      `SELECT version FROM "zugzug_app"."canonical_version"
        WHERE dim_id = $1 AND tenant_id = $2 AND key = 'gamma'`,
      [dimId, T],
    );
    expect(v).not.toBeNull();

    const result = await retireCanonical(dimId, "gamma", USER_ID, v!.version, T);
    expect(result.ok).toBe(false);
    expect(result.variants).toBeGreaterThan(0);

    const count = await pgGet<{ n: number }>(
      `SELECT count(*)::int AS n FROM "zugzug_app"."outbound_event"
        WHERE tenant_id = $1 AND type = 'canonical.deleted' AND dim_id = $2`,
      [T, dimId],
    );
    expect(count!.n).toBe(0);

    await cleanup();
  });
});
