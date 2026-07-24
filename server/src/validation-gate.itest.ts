process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.ZUGZUG_CURSOR_KEY =
  process.env.ZUGZUG_CURSOR_KEY || "lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8=";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun, pgGet } from "./pg.ts";
import { pgAll, parseFieldConfig } from "./repo-shared.ts";
import { addRefTable, addRecordOne, addField, deleteRefTable, listFields } from "./repo-record.ts";
import { commit, saveDraft } from "./repo-drafts.ts";

async function dropDims(tenants: string[]): Promise<void> {
  for (const tenant of tenants) {
    const refTables = await pgAll<{ id: string }>(
      `SELECT id FROM "zugzug_app"."reference_table" WHERE tenant_id = $1`,
      [tenant],
    ).catch(() => [] as { id: string }[]);
    for (const d of refTables) await deleteRefTable(d.id, "test-teardown", tenant).catch(() => {});
  }
}

const T = "test_valgate";
const U = "u_test_valgate";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'ValGate', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Val Gate User', 'valgate@example.test', 'VG', false)
     ON CONFLICT DO NOTHING`,
    [U],
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
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("publish gate — validation", () => {
  it("blocks publish when a value is out of range", async () => {
    // Arrange: refTable with a numeric "population" field, min 0
    const refTableId = await addRefTable("RangeDim", [], { keyKind: "slug" }, U, T);

    // Add two record rows directly
    await addRecordOne(refTableId, "Country A", "country_a", U, T);
    await addRecordOne(refTableId, "Country B", "country_b", U, T);

    // Add a number field
    const added = await addField(refTableId, "Population", "number", undefined, {}, U, T);
    expect(added?.field).toBe("population");

    // Inject validation: min 0 into field_config via SQL (addField doesn't expose validation yet)
    await pgRun(
      `UPDATE "zugzug_app"."reference_table_field"
       SET field_config = $1
       WHERE reference_table_id = $2 AND tenant_id = $3 AND field = 'population'`,
      [JSON.stringify({ validation: { min: 0 } }), refTableId, T],
    );

    // Get the refTable table name to insert values directly
    const meta = await pgGet<{ dimTable: string; keyCol: string }>(
      `SELECT dim_table AS "dimTable", key_col AS "keyCol" FROM "zugzug_app"."reference_table" WHERE id = $1 AND tenant_id = $2`,
      [refTableId, T],
    );

    // Set population: country_a = 100 (valid), country_b = -5 (out of range)
    await pgRun(
      `UPDATE "${meta!.dimTable.split(".")[0]}"."${meta!.dimTable.split(".")[1]}" SET population = $1 WHERE ${meta!.keyCol} = $2`,
      [100, "country_a"],
    );
    await pgRun(
      `UPDATE "${meta!.dimTable.split(".")[0]}"."${meta!.dimTable.split(".")[1]}" SET population = $1 WHERE ${meta!.keyCol} = $2`,
      [-5, "country_b"],
    );

    // Act + Assert: commit should throw VALIDATION_FAILED
    await expect(commit(refTableId, U, T)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
  });

  it("blocks publish when a date value is before the min bound", async () => {
    // Arrange: refTable with a date "start_date" field, min bound "2024-01-01"
    const refTableId = await addRefTable("DateRangeDim", [], { keyKind: "slug" }, U, T);

    await addRecordOne(refTableId, "Event A", "event_a", U, T);
    await addRecordOne(refTableId, "Event B", "event_b", U, T);

    const added = await addField(refTableId, "Start Date", "date", undefined, {}, U, T);
    expect(added?.field).toBe("start_date");

    // Inject validation: min "2024-01-01"
    await pgRun(
      `UPDATE "zugzug_app"."reference_table_field"
       SET field_config = $1
       WHERE reference_table_id = $2 AND tenant_id = $3 AND field = 'start_date'`,
      [JSON.stringify({ validation: { min: "2024-01-01" } }), refTableId, T],
    );

    const meta = await pgGet<{ dimTable: string; keyCol: string }>(
      `SELECT dim_table AS "dimTable", key_col AS "keyCol" FROM "zugzug_app"."reference_table" WHERE id = $1 AND tenant_id = $2`,
      [refTableId, T],
    );

    const schema = meta!.dimTable.split(".")[0];
    const table = meta!.dimTable.split(".")[1];

    // event_a = valid date, event_b = before the min bound
    await pgRun(`UPDATE "${schema}"."${table}" SET start_date = $1 WHERE ${meta!.keyCol} = $2`, [
      "2024-06-15",
      "event_a",
    ]);
    await pgRun(`UPDATE "${schema}"."${table}" SET start_date = $1 WHERE ${meta!.keyCol} = $2`, [
      "2023-12-31",
      "event_b",
    ]);

    // Act + Assert: commit should throw VALIDATION_FAILED
    await expect(commit(refTableId, U, T)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
  });

  it("blocks publish on a duplicate in a unique column", async () => {
    // Arrange: refTable with a text "ticker" field that must be unique
    const refTableId = await addRefTable("UniqueDim", [], { keyKind: "slug" }, U, T);

    await addRecordOne(refTableId, "Asia Pacific", "apac1", U, T);
    await addRecordOne(refTableId, "Asia Pacific 2", "apac2", U, T);

    const added = await addField(refTableId, "Ticker", "text", undefined, {}, U, T);
    expect(added?.field).toBe("ticker");

    // Set validation: unique
    await pgRun(
      `UPDATE "zugzug_app"."reference_table_field"
       SET field_config = $1
       WHERE reference_table_id = $2 AND tenant_id = $3 AND field = 'ticker'`,
      [JSON.stringify({ validation: { unique: true } }), refTableId, T],
    );

    const meta = await pgGet<{ dimTable: string; keyCol: string }>(
      `SELECT dim_table AS "dimTable", key_col AS "keyCol" FROM "zugzug_app"."reference_table" WHERE id = $1 AND tenant_id = $2`,
      [refTableId, T],
    );

    const schema = meta!.dimTable.split(".")[0];
    const table = meta!.dimTable.split(".")[1];

    // Both rows get the same ticker (case-insensitive duplicate)
    await pgRun(`UPDATE "${schema}"."${table}" SET ticker = $1 WHERE ${meta!.keyCol} = $2`, [
      "APAC",
      "apac1",
    ]);
    await pgRun(`UPDATE "${schema}"."${table}" SET ticker = $1 WHERE ${meta!.keyCol} = $2`, [
      "apac",
      "apac2",
    ]);

    await expect(commit(refTableId, U, T)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
  });

  it("still blocks on an empty required field with REQUIRED_FIELDS_EMPTY code", async () => {
    // Parity with today's REQUIRED_FIELDS_EMPTY behavior (only required violations present)
    const refTableId = await addRefTable("ReqOnlyDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "United States", "usa", U, T);
    const added = await addField(refTableId, "Region", "text", undefined, { required: true }, U, T);
    expect(added?.field).toBe("region");

    // No value set for the required field — should block
    await expect(commit(refTableId, U, T)).rejects.toMatchObject({
      code: "REQUIRED_FIELDS_EMPTY",
      status: 422,
    });
  });

  it("round-trips validation through addField into field_config", async () => {
    // Arrange: new refTable with a number field written via addField
    const refTableId = await addRefTable("ValidationRoundTripDim", [], { keyKind: "slug" }, U, T);

    const added = await addField(
      refTableId,
      "Score",
      "number",
      undefined,
      { validation: { unique: true, min: 0 }, required: true },
      U,
      T,
    );
    expect(added?.field).toBe("score");

    // Act: read field_config back from DB and parse it
    const raw = await pgGet<{ field_config: string | null }>(
      `SELECT field_config FROM "zugzug_app"."reference_table_field" WHERE reference_table_id = $1 AND tenant_id = $2 AND field = 'score'`,
      [refTableId, T],
    );
    expect(raw).not.toBeNull();
    const parsed = parseFieldConfig("number", raw!.field_config);

    // Assert: validation and required round-tripped intact
    expect(parsed.required).toBe(true);
    expect(parsed.validation).toEqual({ unique: true, min: 0 });

    // Also verify listFields surfaces the same values (full stack)
    const fields = await listFields(refTableId, T);
    const scoreField = fields.find((f) => f.field === "score");
    expect(scoreField?.required).toBe(true);
    expect(scoreField?.validation).toEqual({ unique: true, min: 0 });
  });

  it("publishes cleanly when all rules pass", async () => {
    const refTableId = await addRefTable("CleanDim", [], { keyKind: "slug" }, U, T);
    await addRecordOne(refTableId, "Denmark", "dk", U, T);

    const added = await addField(refTableId, "Score", "number", undefined, {}, U, T);
    expect(added?.field).toBe("score");

    // Set validation: min 0, max 100
    await pgRun(
      `UPDATE "zugzug_app"."reference_table_field"
       SET field_config = $1
       WHERE reference_table_id = $2 AND tenant_id = $3 AND field = 'score'`,
      [JSON.stringify({ validation: { min: 0, max: 100 } }), refTableId, T],
    );

    const meta = await pgGet<{ dimTable: string; keyCol: string }>(
      `SELECT dim_table AS "dimTable", key_col AS "keyCol" FROM "zugzug_app"."reference_table" WHERE id = $1 AND tenant_id = $2`,
      [refTableId, T],
    );

    const schema = meta!.dimTable.split(".")[0];
    const table = meta!.dimTable.split(".")[1];

    // Valid score
    await pgRun(`UPDATE "${schema}"."${table}" SET score = $1 WHERE ${meta!.keyCol} = $2`, [
      85,
      "dk",
    ]);

    // Add a draft so the publish has at least one mapping to fold
    await saveDraft(refTableId, "Danmark", "mapped", "Denmark", "dk", U, T);

    const res = await commit(refTableId, U, T);
    expect(res.committed).toBeGreaterThan(0);
  });
});
