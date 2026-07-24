import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pgRun, pgGet } from "./pg.ts";
import { addRefTable } from "./repo-record.ts";

const T = "test_cv_backfill";
const USER_ID = "u_cv_backfill";
const DIM_NAME = "CV Backfill RefTable";
const REF_TABLE_ID = "cv_backfill_reftable";

beforeAll(async () => {
  // Clean any prior run.
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${REF_TABLE_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${REF_TABLE_ID}"`).catch(() => {});
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
  await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."reference_table_source" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${REF_TABLE_ID}"`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${REF_TABLE_ID}"`).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [USER_ID]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("record_version backfill from audit_log", () => {
  it("populates updated_at from the latest matching audit_log row", async () => {
    // 1. Create refTable (this creates dim_<id>/map_<id> in zugzug schema, plus
    //    a row in zugzug_app.reference_table).
    const refTableId = await addRefTable(DIM_NAME, [], {}, USER_ID, T);
    expect(refTableId).toBe(REF_TABLE_ID);

    // Look up dim_table + key_col strings (the migration loops over refTable to
    // get these — we mirror that here so the inner UPSERT we run is the exact
    // SQL the migration's PL/pgSQL block will EXECUTE).
    const refTable = await pgGet<{ dim_table: string; key_col: string }>(
      `SELECT dim_table, key_col FROM "zugzug_app"."reference_table"
        WHERE id = $1 AND tenant_id = $2`,
      [refTableId, T],
    );
    expect(refTable).not.toBeNull();

    // 2. Insert a row directly into dim_<slug> WITHOUT going through addRecord
    //    (simulating pre-versioning state — no matching record_version row).
    const legacyKey = "LEGACY";
    await pgRun(
      `INSERT INTO "${refTable!.dim_table.split(".")[0]}"."${refTable!.dim_table.split(".")[1]}"
         ("${refTable!.key_col}", label, tenant_id) VALUES ($1, $2, $3)`,
      [legacyKey, "Legacy Label", T],
    );

    // 3. Insert an audit_log row with action='Added record', table_id=refTable.id,
    //    row_key='LEGACY', created_at=fixed historical ts.
    // audit_log.created_at is timestamp (no tz). Insert via a literal that
    // Postgres reads as naive-local so the round-trip through the JS Date
    // doesn't drift by the local UTC offset.
    const historicalLiteral = "2025-01-15 12:00:00";
    await pgRun(
      `INSERT INTO "zugzug_app"."audit_log"
         (id, created_at, user_id, action, detail, table_id, row_key, tenant_id)
       VALUES ($1, $2::timestamp, $3, 'Added record', $4, $5, $6, $7)`,
      [randomUUID(), historicalLiteral, USER_ID, "Legacy Label (LEGACY)", refTableId, legacyKey, T],
    );
    // Read back the audit row's timestamp the same way the UPSERT will — both
    // go through the same Date conversion so any tz offset cancels out.
    const auditRow = await pgGet<{ created_at: Date }>(
      `SELECT created_at FROM "zugzug_app"."audit_log"
        WHERE tenant_id = $1 AND table_id = $2 AND row_key = $3`,
      [T, refTableId, legacyKey],
    );
    expect(auditRow).not.toBeNull();

    // Sanity: no record_version row yet for this key.
    const before = await pgGet(
      `SELECT key FROM "zugzug_app"."record_version"
        WHERE tenant_id = $1 AND reference_table_id = $2 AND key = $3`,
      [T, refTableId, legacyKey],
    );
    expect(before).toBeNull();

    // 4. Run the inner UPSERT (parameterized — the PL/pgSQL wrapper is a thin
    //    loop over every (tenant, refTable) pair). We build the SQL identically to
    //    the migration's format() call.
    const [schema, table] = refTable!.dim_table.split(".");
    const keyCol = refTable!.key_col;
    const sql = `
      INSERT INTO "zugzug_app"."record_version"
        (tenant_id, reference_table_id, key, version, updated_at, updated_by)
      SELECT $1::varchar, $2::varchar, "${keyCol}", 0,
             coalesce(
               (SELECT max(created_at) FROM "zugzug_app"."audit_log"
                 WHERE tenant_id = $1::varchar
                   AND table_id  = $2::varchar
                   AND row_key   = "${keyCol}"
                   AND action IN ('Added record', 'Renamed record',
                                  'Merged record', 'Retired record',
                                  'Inserted record at position',
                                  'Reordered record')),
               now()),
             'migration:phase1'
      FROM "${schema}"."${table}"
      WHERE tenant_id = $1::varchar
      ON CONFLICT (tenant_id, reference_table_id, key) DO NOTHING
    `;
    await pgRun(sql, [T, refTableId]);

    // 5. SELECT updated_at + updated_by from record_version for ('LEGACY').
    const after = await pgGet<{ updated_at: Date; updated_by: string }>(
      `SELECT updated_at, updated_by FROM "zugzug_app"."record_version"
        WHERE tenant_id = $1 AND reference_table_id = $2 AND key = $3`,
      [T, refTableId, legacyKey],
    );
    expect(after).not.toBeNull();

    // 6. Assert updated_by === 'migration:phase1'.
    expect(after!.updated_by).toBe("migration:phase1");

    // 7. Assert updated_at matches the audit_log timestamp (both round-tripped
    //    via the same Date conversion).
    const drift = Math.abs(after!.updated_at.getTime() - auditRow!.created_at.getTime());
    expect(drift).toBeLessThan(1000);
  });

  it("audit-log filter list matches every record action emitted by repo-record", async () => {
    const src = readFileSync(join(__dirname, "repo-record.ts"), "utf8");
    const matches = [...src.matchAll(/appendAudit\w*\([^,]+,\s*"([^"]+record[^"]*)"/g)];
    const actions = new Set(matches.map((m) => m[1]));
    const expected = new Set([
      "Added record",
      "Renamed record",
      "Merged record",
      "Retired record",
      "Inserted record at position",
      "Reordered record",
    ]);
    // "Edited record" (setFieldValue) mutates the working copy but does not
    // stamp a new version — versions are stamped at publish (ADR-0002) — so it
    // is intentionally absent from the 0025 version-backfill filter.
    const excludedFromBackfill = new Set(["Edited record"]);
    // Every record action found in source must be a version-stamping mutation
    // present in the migration's filter list, or an explicitly excluded one.
    // A genuinely new mutation lands in neither set and fails here — a signal
    // that the migration's IN(...) clause needs to grow, otherwise backfilled
    // timestamps drift.
    for (const a of actions) {
      expect(expected.has(a) || excludedFromBackfill.has(a)).toBe(true);
    }
  });
});
