process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import * as repo from "../src/repo-canonical.ts";

const DIM = "d_route_conflict";
const DIM_TABLE = "zugzug_app.dim_route_conflict";
const MAP_TABLE = "zugzug_app.map_route_conflict";
const DIM_TABLE_Q = `"zugzug_app"."dim_route_conflict"`;
const MAP_TABLE_Q = `"zugzug_app"."map_route_conflict"`;
const KEY_COL = "country_id";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension"
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, now(), 'default')
     ON CONFLICT (tenant_id, id) DO UPDATE SET dim_table = EXCLUDED.dim_table, map_table = EXCLUDED.map_table, key_col = EXCLUDED.key_col`,
    [DIM, "Route Conflict", DIM_TABLE, MAP_TABLE, KEY_COL],
  );
  await pgRun(`CREATE TABLE IF NOT EXISTS ${DIM_TABLE_Q} (${KEY_COL} varchar PRIMARY KEY, label varchar)`);
  await pgRun(`CREATE TABLE IF NOT EXISTS ${MAP_TABLE_Q} (raw varchar, ${KEY_COL} varchar)`);
  await pgRun(`DELETE FROM ${DIM_TABLE_Q}`);
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE dim_id = $1`, [DIM]);
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials)
     VALUES ('u_route_actor', 'Route Actor', 'RA')
     ON CONFLICT (id) DO NOTHING`,
  );
  await repo.addCanonicalOne(DIM, "Denmark", "dk", "u_route_actor", "default");
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE dim_id = $1`, [DIM]);
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE id = $1`, [DIM]);
});

test("renameCanonical with stale version throws AppError with details.current shape", async () => {
  // Bump out of band so the next call is stale.
  await repo.renameCanonical(DIM, "dk", "Danmark", "u_route_actor", 1, "default");
  let thrown: { code?: string; status?: number; details?: { current?: { version?: number; updatedBy?: { id?: string; name?: string; initials?: string } } } } = {};
  try {
    await repo.renameCanonical(DIM, "dk", "DenmarkAgain", "u_route_actor", 1, "default");
  } catch (e) {
    thrown = e as typeof thrown;
  }
  expect(thrown.code).toBe("CONFLICT");
  expect(thrown.status).toBe(409);
  expect(thrown.details?.current?.version).toBe(2);
  expect(thrown.details?.current?.updatedBy?.id).toBe("u_route_actor");
  expect(thrown.details?.current?.updatedBy?.name).toBe("Route Actor");
  expect(thrown.details?.current?.updatedBy?.initials).toBe("RA");
});
