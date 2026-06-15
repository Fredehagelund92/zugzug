process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.MOTHERDUCK_TOKEN = "md_test";
process.env.WAREHOUSE_DB = "analytics";
process.env.ATTACH_WAREHOUSE = "false";
process.env.WAREHOUSE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd=";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import {
  createWarehouseConnection,
  addWarehouseDatabase,
} from "../src/repo-warehouse.ts";

const T = `twh_${process.pid}`;
const ADMIN = `u_admin_${process.pid}`;

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."user_warehouse_state" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_connection" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."active_sessions" WHERE user_id = $1`, [ADMIN]);
  await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [ADMIN]);
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [ADMIN]);
}
beforeEach(cleanup);

async function setupWithConnection(): Promise<{ cookie: string; tenantSlug: string; connId: string; dbId: string }> {
  await provisionTenant({ id: T, label: "Whouse" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, is_super_admin)
     VALUES ($1, $2, $3, true)`,
    [ADMIN, `Admin ${ADMIN}`, "A"],
  );
  const sid = `s_${ADMIN}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."sessions" (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [sid, ADMIN],
  );
  const conn = await createWarehouseConnection({
    tenantId: T,
    adapter: "motherduck",
    label: "Prod",
    credentials: { type: "duckdb", token: "md_x", writable: false },
    actorUserId: ADMIN,
  });
  const wd = await addWarehouseDatabase({
    tenantId: T,
    connectionId: conn.id,
    databaseName: "analytics",
    actorUserId: ADMIN,
  });
  return { cookie: `zz_sid=${sid}`, tenantSlug: T, connId: conn.id, dbId: wd.id };
}

test("GET /api/t/:slug/warehouse/connection returns the projection (no credentials)", async () => {
  const { cookie, tenantSlug, connId } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    id: string;
    adapter: string;
    credentialsVersion: number;
    credentials?: unknown;
  };
  expect(body.id).toBe(connId);
  expect(body.adapter).toBe("motherduck");
  expect(body.credentialsVersion).toBe(1);
  expect(body).not.toHaveProperty("credentials");
});

test("GET /api/t/:slug/warehouse/connection returns null when none configured", async () => {
  await provisionTenant({ id: T, label: "Empty" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, is_super_admin)
     VALUES ($1, $2, $3, true)`,
    [ADMIN, `Admin ${ADMIN}`, "A"],
  );
  const sid = `s_${ADMIN}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."sessions" (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [sid, ADMIN],
  );
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${T}/warehouse/connection`, {
      headers: { cookie: `zz_sid=${sid}` },
    }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toBeNull();
});

test("GET /api/t/:slug/warehouse/databases returns the list with sourceCount=0", async () => {
  const { cookie, tenantSlug, dbId } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/databases`, {
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<{
    id: string;
    databaseName: string;
    sourceCount: number;
  }>;
  expect(body.length).toBe(1);
  expect(body[0].id).toBe(dbId);
  expect(body[0].databaseName).toBe("analytics");
  expect(body[0].sourceCount).toBe(0);
});

test("POST /warehouse/connection encrypts the credentials and returns the projection", async () => {
  await provisionTenant({ id: T, label: "WriteTest" });
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, is_super_admin)
     VALUES ($1, $2, $3, true)`,
    [ADMIN, `Admin ${ADMIN}`, "A"],
  );
  const sid = `s_${ADMIN}`;
  await pgRun(
    `INSERT INTO "zugzug_app"."sessions" (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [sid, ADMIN],
  );
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${T}/warehouse/connection`, {
      method: "POST",
      headers: { cookie: `zz_sid=${sid}`, "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "motherduck",
        label: "MyProd",
        credentials: { type: "duckdb", token: "md_user_token", writable: false },
      }),
    }),
    () => {},
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.adapter).toBe("motherduck");
  expect(body).not.toHaveProperty("credentials");
});

test("PATCH /warehouse/connection 412 on stale If-Match", async () => {
  const { cookie, tenantSlug } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "If-Match": "99" },
      body: JSON.stringify({ label: "Renamed" }),
    }),
    () => {},
  );
  expect(res.status).toBe(412);
  const body = await res.json();
  expect(body.kind).toBe("STALE_VERSION");
  expect(body.currentVersion).toBe(1);
});

test("PATCH /warehouse/connection with same credentials does not bump version", async () => {
  const { cookie, tenantSlug } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "If-Match": "1" },
      body: JSON.stringify({ credentials: { type: "duckdb", token: "md_x", writable: false } }),
    }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.credentialsVersion).toBe(1);
});

test("DELETE /warehouse/connection returns 409 while databases exist", async () => {
  const { cookie, tenantSlug } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/connection`, {
      method: "DELETE",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.kind).toBe("CONNECTION_IN_USE");
  expect(body.databaseCount).toBe(1);
});

test("POST /warehouse/databases rejects invalid identifier", async () => {
  const { cookie, tenantSlug } = await setupWithConnection();
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/databases`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ databaseName: "bad'name" }),
    }),
    () => {},
  );
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.kind).toBe("INVALID_IDENTIFIER");
});

test("DELETE /warehouse/databases/:id returns 409 when sources exist (no force)", async () => {
  const { cookie, tenantSlug, dbId } = await setupWithConnection();
  // dimension_source has no FK to `dimension` — insert directly with a synthetic dim_id.
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension_source"
       (tenant_id, dim_id, database_id, schema_name, table_name, column_name)
     VALUES ($1, $2, $3, 'public', 'orders', 'country')`,
    [T, "dim_test_t14", dbId],
  );
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/warehouse/databases/${dbId}`, {
      method: "DELETE",
      headers: { cookie },
    }),
    () => {},
  );
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.kind).toBe("DATABASE_IN_USE");
  expect(body.sourceCount).toBeGreaterThanOrEqual(1);
  expect(Array.isArray(body.dimensions)).toBe(true);
  expect(body.dimensions[0]?.dimId).toBe("dim_test_t14");
  expect(body.dimensions[0]?.sources).toContain("public.orders.country");
});

/** Helper: registers a synthetic dimension so POST /sources has a target. */
async function seedDimension(dimId: string): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."dimension"
       (id, label, dim_table, map_table, key_col, created_at, tenant_id)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [dimId, "Test Dim", `zugzug_app.dim_${dimId}`, `zugzug_app.map_${dimId}`, `${dimId}_code`, T],
  );
}

test("POST /dimensions/:id/sources accepts the qualified shape, sets MRU, no Deprecation header", async () => {
  const { cookie, tenantSlug, dbId } = await setupWithConnection();
  const dimId = `dim_test_t16_qual`;
  await seedDimension(dimId);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/dimensions/${dimId}/sources`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        source: {
          databaseId: dbId,
          schemaName: "raw",
          tableName: "orders",
          columnName: "country",
        },
      }),
    }),
    () => {},
  );
  expect(res.status).toBe(204);
  expect(res.headers.get("Deprecation")).toBeNull();
  // Row landed with the new columns.
  const { pgGet } = await import("../src/pg.ts");
  const row = await pgGet<{
    database_id: string;
    schema_name: string;
    table_name: string;
    column_name: string;
  }>(
    `SELECT database_id, schema_name, table_name, column_name FROM "zugzug_app"."dimension_source"
       WHERE tenant_id = $1 AND dim_id = $2`,
    [T, dimId],
  );
  expect(row?.database_id).toBe(dbId);
  expect(row?.schema_name).toBe("raw");
  expect(row?.table_name).toBe("orders");
  expect(row?.column_name).toBe("country");
  // MRU pointer was set.
  const mru = await pgGet<{ recent_database_id: string }>(
    `SELECT recent_database_id FROM "zugzug_app"."user_warehouse_state"
       WHERE tenant_id = $1 AND user_id = $2`,
    [T, ADMIN],
  );
  expect(mru?.recent_database_id).toBe(dbId);
});

test("POST /dimensions/:id/sources legacy shape resolves via preferences + sets Deprecation header", async () => {
  const { cookie, tenantSlug, dbId } = await setupWithConnection();
  const dimId = `dim_test_t16_legacy`;
  await seedDimension(dimId);
  // Seed preferences with the legacy default DB pointer.
  await pgRun(
    `INSERT INTO "zugzug_app"."preferences"
       (publish_threshold, suggest_threshold, scan_schedule, updated_at, tenant_id, legacy_default_database_id)
     VALUES (10, 5, NULL, now(), $1, $2)
     ON CONFLICT (tenant_id) DO UPDATE
       SET legacy_default_database_id = EXCLUDED.legacy_default_database_id`,
    [T, dbId],
  );
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/dimensions/${dimId}/sources`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ source: { table: "raw.shipments", column: "destination_country" } }),
    }),
    () => {},
  );
  expect(res.status).toBe(204);
  expect(res.headers.get("Deprecation")).toBe("true");
  const { pgGet } = await import("../src/pg.ts");
  const row = await pgGet<{
    database_id: string;
    schema_name: string;
    table_name: string;
    column_name: string;
  }>(
    `SELECT database_id, schema_name, table_name, column_name FROM "zugzug_app"."dimension_source"
       WHERE tenant_id = $1 AND dim_id = $2`,
    [T, dimId],
  );
  expect(row?.database_id).toBe(dbId);
  expect(row?.schema_name).toBe("raw");
  expect(row?.table_name).toBe("shipments");
  expect(row?.column_name).toBe("destination_country");
});

test("POST /dimensions/:id/sources legacy shape without preferences default returns 422", async () => {
  const { cookie, tenantSlug } = await setupWithConnection();
  const dimId = `dim_test_t16_ambiguous`;
  await seedDimension(dimId);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request(`http://localhost/api/t/${tenantSlug}/dimensions/${dimId}/sources`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ source: { table: "raw.shipments", column: "destination_country" } }),
    }),
    () => {},
  );
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.kind).toBe("BACKEND_LEGACY_SHAPE_AMBIGUOUS");
});
