import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pgRun, pgGet } from "./pg.ts";
import { addDimension } from "./repo-canonical.ts";

const T = "test_cv_backfill";
const USER_ID = "u_cv_backfill";
const DIM_NAME = "CV Backfill Dim";
const DIM_ID = "cv_backfill_dim";

beforeAll(async () => {
  // Clean any prior run.
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${DIM_ID}"`).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [USER_ID]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});

  // Seed tenant + user (audit_log FKs users).
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'CV Backfill', now())`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, email, name, initials)
     VALUES ($1, 'cv-backfill@example.com', 'CV Backfill', 'CB')
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${DIM_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${DIM_ID}"`).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [USER_ID]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("canonical_version backfill from audit_log", () => {
  it("populates updated_at from the latest matching audit_log row", async () => {
    // 1. Create dimension (this creates dim_<id>/map_<id> in zugzug schema, plus
    //    a row in zugzug_app.dimension).
    const dimId = await addDimension(DIM_NAME, [], {}, USER_ID, T);
    expect(dimId).toBe(DIM_ID);

    // Look up dim_table + key_col strings (the migration loops over dimension to
    // get these — we mirror that here so the inner UPSERT we run is the exact
    // SQL the migration's PL/pgSQL block will EXECUTE).
    const dim = await pgGet<{ dim_table: string; key_col: string }>(
      `SELECT dim_table, key_col FROM "zugzug_app"."dimension"
        WHERE id = $1 AND tenant_id = $2`,
      [dimId, T],
    );
    expect(dim).not.toBeNull();

    // 2. Insert a row directly into dim_<slug> WITHOUT going through addCanonical
    //    (simulating pre-versioning state — no matching canonical_version row).
    const legacyKey = "LEGACY";
    await pgRun(
      `INSERT INTO "${dim!.dim_table.split(".")[0]}"."${dim!.dim_table.split(".")[1]}"
         ("${dim!.key_col}", label, tenant_id) VALUES ($1, $2, $3)`,
      [legacyKey, "Legacy Label", T],
    );

    // 3. Insert an audit_log row with action='Added canonical', table_id=dim.id,
    //    row_key='LEGACY', created_at=fixed historical ts.
    // audit_log.created_at is timestamp (no tz). Insert via a literal that
    // Postgres reads as naive-local so the round-trip through the JS Date
    // doesn't drift by the local UTC offset.
    const historicalLiteral = "2025-01-15 12:00:00";
    await pgRun(
      `INSERT INTO "zugzug_app"."audit_log"
         (id, created_at, user_id, action, detail, table_id, row_key, tenant_id)
       VALUES ($1, $2::timestamp, $3, 'Added canonical', $4, $5, $6, $7)`,
      [
        randomUUID(),
        historicalLiteral,
        USER_ID,
        "Legacy Label (LEGACY)",
        dimId,
        legacyKey,
        T,
      ],
    );
    // Read back the audit row's timestamp the same way the UPSERT will — both
    // go through the same Date conversion so any tz offset cancels out.
    const auditRow = await pgGet<{ created_at: Date }>(
      `SELECT created_at FROM "zugzug_app"."audit_log"
        WHERE tenant_id = $1 AND table_id = $2 AND row_key = $3`,
      [T, dimId, legacyKey],
    );
    expect(auditRow).not.toBeNull();

    // Sanity: no canonical_version row yet for this key.
    const before = await pgGet(
      `SELECT key FROM "zugzug_app"."canonical_version"
        WHERE tenant_id = $1 AND dim_id = $2 AND key = $3`,
      [T, dimId, legacyKey],
    );
    expect(before).toBeNull();

    // 4. Run the inner UPSERT (parameterized — the PL/pgSQL wrapper is a thin
    //    loop over every (tenant, dim) pair). We build the SQL identically to
    //    the migration's format() call.
    const [schema, table] = dim!.dim_table.split(".");
    const keyCol = dim!.key_col;
    const sql = `
      INSERT INTO "zugzug_app"."canonical_version"
        (tenant_id, dim_id, key, version, updated_at, updated_by)
      SELECT $1::varchar, $2::varchar, "${keyCol}", 0,
             coalesce(
               (SELECT max(created_at) FROM "zugzug_app"."audit_log"
                 WHERE tenant_id = $1::varchar
                   AND table_id  = $2::varchar
                   AND row_key   = "${keyCol}"
                   AND action IN ('Added canonical', 'Renamed canonical',
                                  'Merged canonical', 'Retired canonical',
                                  'Inserted canonical at position',
                                  'Reordered canonical')),
               now()),
             'migration:phase1'
      FROM "${schema}"."${table}"
      WHERE tenant_id = $1::varchar
      ON CONFLICT (tenant_id, dim_id, key) DO NOTHING
    `;
    await pgRun(sql, [T, dimId]);

    // 5. SELECT updated_at + updated_by from canonical_version for ('LEGACY').
    const after = await pgGet<{ updated_at: Date; updated_by: string }>(
      `SELECT updated_at, updated_by FROM "zugzug_app"."canonical_version"
        WHERE tenant_id = $1 AND dim_id = $2 AND key = $3`,
      [T, dimId, legacyKey],
    );
    expect(after).not.toBeNull();

    // 6. Assert updated_by === 'migration:phase1'.
    expect(after!.updated_by).toBe("migration:phase1");

    // 7. Assert updated_at matches the audit_log timestamp (both round-tripped
    //    via the same Date conversion).
    const drift = Math.abs(after!.updated_at.getTime() - auditRow!.created_at.getTime());
    expect(drift).toBeLessThan(1000);
  });

  it("audit-log filter list matches every canonical action emitted by repo-canonical", async () => {
    const src = readFileSync(join(__dirname, "repo-canonical.ts"), "utf8");
    const matches = [...src.matchAll(/appendAudit\w*\([^,]+,\s*"([^"]+canonical[^"]*)"/g)];
    const actions = new Set(matches.map((m) => m[1]));
    const expected = new Set([
      "Added canonical",
      "Renamed canonical",
      "Merged canonical",
      "Retired canonical",
      "Inserted canonical at position",
      "Reordered canonical",
    ]);
    // Every action found in source must be present in the migration's filter
    // list. If a new canonical mutation appears here, the migration's IN(...)
    // clause needs to grow to match — otherwise backfilled timestamps drift.
    for (const a of actions) {
      expect(expected.has(a)).toBe(true);
    }
  });
});
