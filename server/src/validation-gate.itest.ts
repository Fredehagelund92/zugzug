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
import {
  addDimension,
  addCanonicalOne,
  addField,
  deleteDimension,
  listFields,
} from "./repo-canonical.ts";
import { commit, saveDraft } from "./repo-drafts.ts";

async function dropDims(tenants: string[]): Promise<void> {
  for (const tenant of tenants) {
    const dims = await pgAll<{ id: string }>(
      `SELECT id FROM "zugzug_app"."dimension" WHERE tenant_id = $1`,
      [tenant],
    ).catch(() => [] as { id: string }[]);
    for (const d of dims) await deleteDimension(d.id, "test-teardown", tenant).catch(() => {});
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
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("publish gate — validation", () => {
  it("blocks publish when a value is out of range", async () => {
    // Arrange: dimension with a numeric "population" field, min 0
    const dimId = await addDimension("RangeDim", [], { keyKind: "slug" }, U, T);

    // Add two canonical rows directly
    await addCanonicalOne(dimId, "Country A", "country_a", U, T);
    await addCanonicalOne(dimId, "Country B", "country_b", U, T);

    // Add a number field
    const added = await addField(dimId, "Population", "number", undefined, {}, U, T);
    expect(added?.field).toBe("population");

    // Inject validation: min 0 into field_config via SQL (addField doesn't expose validation yet)
    await pgRun(
      `UPDATE "zugzug_app"."dimension_field"
       SET field_config = $1
       WHERE dim_id = $2 AND tenant_id = $3 AND field = 'population'`,
      [JSON.stringify({ validation: { min: 0 } }), dimId, T],
    );

    // Get the dim table name to insert values directly
    const meta = await pgGet<{ dimTable: string; keyCol: string }>(
      `SELECT dim_table AS "dimTable", key_col AS "keyCol" FROM "zugzug_app"."dimension" WHERE id = $1 AND tenant_id = $2`,
      [dimId, T],
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
    await expect(commit(dimId, U, T)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
  });

  it("blocks publish on a duplicate in a unique column", async () => {
    // Arrange: dimension with a text "ticker" field that must be unique
    const dimId = await addDimension("UniqueDim", [], { keyKind: "slug" }, U, T);

    await addCanonicalOne(dimId, "Asia Pacific", "apac1", U, T);
    await addCanonicalOne(dimId, "Asia Pacific 2", "apac2", U, T);

    const added = await addField(dimId, "Ticker", "text", undefined, {}, U, T);
    expect(added?.field).toBe("ticker");

    // Set validation: unique
    await pgRun(
      `UPDATE "zugzug_app"."dimension_field"
       SET field_config = $1
       WHERE dim_id = $2 AND tenant_id = $3 AND field = 'ticker'`,
      [JSON.stringify({ validation: { unique: true } }), dimId, T],
    );

    const meta = await pgGet<{ dimTable: string; keyCol: string }>(
      `SELECT dim_table AS "dimTable", key_col AS "keyCol" FROM "zugzug_app"."dimension" WHERE id = $1 AND tenant_id = $2`,
      [dimId, T],
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

    await expect(commit(dimId, U, T)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
  });

  it("still blocks on an empty required field with REQUIRED_FIELDS_EMPTY code", async () => {
    // Parity with today's REQUIRED_FIELDS_EMPTY behavior (only required violations present)
    const dimId = await addDimension("ReqOnlyDim", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "United States", "usa", U, T);
    const added = await addField(dimId, "Region", "text", undefined, { required: true }, U, T);
    expect(added?.field).toBe("region");

    // No value set for the required field — should block
    await expect(commit(dimId, U, T)).rejects.toMatchObject({
      code: "REQUIRED_FIELDS_EMPTY",
      status: 422,
    });
  });

  it("round-trips validation through addField into field_config", async () => {
    // Arrange: new dimension with a number field written via addField
    const dimId = await addDimension("ValidationRoundTripDim", [], { keyKind: "slug" }, U, T);

    const added = await addField(
      dimId,
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
      `SELECT field_config FROM "zugzug_app"."dimension_field" WHERE dim_id = $1 AND tenant_id = $2 AND field = 'score'`,
      [dimId, T],
    );
    expect(raw).not.toBeNull();
    const parsed = parseFieldConfig("number", raw!.field_config);

    // Assert: validation and required round-tripped intact
    expect(parsed.required).toBe(true);
    expect(parsed.validation).toEqual({ unique: true, min: 0 });

    // Also verify listFields surfaces the same values (full stack)
    const fields = await listFields(dimId, T);
    const scoreField = fields.find((f) => f.field === "score");
    expect(scoreField?.required).toBe(true);
    expect(scoreField?.validation).toEqual({ unique: true, min: 0 });
  });

  it("publishes cleanly when all rules pass", async () => {
    const dimId = await addDimension("CleanDim", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "Denmark", "dk", U, T);

    const added = await addField(dimId, "Score", "number", undefined, {}, U, T);
    expect(added?.field).toBe("score");

    // Set validation: min 0, max 100
    await pgRun(
      `UPDATE "zugzug_app"."dimension_field"
       SET field_config = $1
       WHERE dim_id = $2 AND tenant_id = $3 AND field = 'score'`,
      [JSON.stringify({ validation: { min: 0, max: 100 } }), dimId, T],
    );

    const meta = await pgGet<{ dimTable: string; keyCol: string }>(
      `SELECT dim_table AS "dimTable", key_col AS "keyCol" FROM "zugzug_app"."dimension" WHERE id = $1 AND tenant_id = $2`,
      [dimId, T],
    );

    const schema = meta!.dimTable.split(".")[0];
    const table = meta!.dimTable.split(".")[1];

    // Valid score
    await pgRun(`UPDATE "${schema}"."${table}" SET score = $1 WHERE ${meta!.keyCol} = $2`, [
      85,
      "dk",
    ]);

    // Add a draft so the publish has at least one mapping to fold
    await saveDraft(dimId, "Danmark", "mapped", "Denmark", "dk", U, T);

    const res = await commit(dimId, U, T);
    expect(res.committed).toBeGreaterThan(0);
  });
});
