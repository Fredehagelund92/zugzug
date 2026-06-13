process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import "./setup.ts";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgAll, pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import * as canonical from "../src/repo-canonical.ts";

const T = "tdyn_a";
const D = "tdyn_thing";

// The canonical schema name comes from env.canonicalSchema = ZUGZUG_DB || "zugzug".
// In the test environment (no ZUGZUG_DB set) this resolves to "zugzug".
const CANONICAL_SCHEMA = process.env.ZUGZUG_DB?.trim() || "zugzug";

async function cleanup(): Promise<void> {
  await pgRun(`DROP TABLE IF EXISTS "${CANONICAL_SCHEMA}"."dim_${D}"`);
  await pgRun(`DROP TABLE IF EXISTS "${CANONICAL_SCHEMA}"."map_${D}"`);
  await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."dimension_field" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
}
beforeEach(cleanup);
afterAll(cleanup);

test("addDimension creates dim_/map_ with tenant_id NOT NULL DEFAULT '<tenant>'", async () => {
  await provisionTenant({ id: T, label: "A" });
  await canonical.addDimension(D, [], { keyKind: "slug" }, "u_test", T);

  const dimCols = await pgAll<{ column_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    [CANONICAL_SCHEMA, `dim_${D}`],
  );
  const mapCols = await pgAll<{ column_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    [CANONICAL_SCHEMA, `map_${D}`],
  );

  for (const cols of [dimCols, mapCols]) {
    const t = cols.find((c) => c.column_name === "tenant_id");
    expect(t).toBeDefined();
    expect(t?.is_nullable).toBe("NO");
    expect(t?.column_default ?? "").toContain(T);
  }
});

test("invalid tenant id throws (defense-in-depth)", async () => {
  let thrown: Error | null = null;
  try {
    await canonical.addDimension("bad_dim", [], { keyKind: "slug" }, "u_test", "'; DROP TABLE--");
  } catch (e) {
    thrown = e as Error;
  }
  expect(thrown).not.toBeNull();
  expect(thrown?.message).toContain("invalid tenant_id");
});
